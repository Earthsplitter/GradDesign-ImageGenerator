/**
 * Created by mingmwen.  Mar. 29 2018
 * 这是总的处理入口, 和请求脱钩不处理发包回包
 * 主要功能:
 * 1. 静态图片(png, jpg)生成
 * 2. 动态gif生成
 * 3. chrome 以及 page 创建和生成
 * 4. page调度(队列事件系统)
 */

const Uploader = require('hybrid/app/platform/upload/api/index')
const puppeteer = require('picGenerator/index')
const gifMaker = require('./gifMaker')
const cluster = require('cluster')
const EventEmitter = require('events')

let chromeInstance = null
// For 8 cores CPU, there will be 64 pages(1 chrome per worker, 8 pages per chrome)
const PAGE_POOL_LIMIT = 8
const MAX_IN_QUEUE_TIME = 5000
const GIF_MAX_FRAMES = 12
const DEFAULT_OPTS = {
    uploadParams: {                 // if uploadToAlubm is true, must pass uin and p_skey
        type      : 'pic',
        appid     : 'pic_qzone',
        uin       : 0,              // required, String
        title     : '',
        albumID   : '',
        albumType : 22,
        totalNum  : 1,
        uploadType: 3,
        file_len  : 0,
        check_type: 2,
        env		  : {
            refer   : 'shuoshuo',
            entrance: 14,
            source  : 5
        },
        token: {
            type   : 4,
            data   : Buffer.from(''),       // uin, required, Buffer
            ext_key: Buffer.from(''),       // pskey, required, Buffer
            appid  : 1000398
        }
    },
    logger:  _ => {}                            // Function. Optional. Default: null(no log)
}
class ScreenshotQueueEmitter extends EventEmitter {}

class htmlCliper {
    constructor (params) {
        this.browser = params.browser
        this.pagePool = params.pagePool
        this.logger = params.logger || DEFAULT_OPTS.logger
        this.uploadParams = DEFAULT_OPTS.uploadParams
        this.pageCount = params.pagePool.length

        // initialize queue module
        this.screenshotQueueEmitter = new ScreenshotQueueEmitter()
        this.screenshotQueue = []
        this.screenshotQueueEmitter.on('release', _ => {
            // no request is wating, just return
            if (this.screenshotQueue.length === 0) {
                return
            }
            // find idle page
            const pageObj = this.pagePool.find(pageInPool => {
                return pageInPool.isUsing === false
            })

            // no available page(maybe occupied by a new request)
            if (!pageObj) {
                return
            } else {
                pageObj.isUsing = true

                let waitingPage = {}
                // find the first not rejected page
                do {
                    waitingPage = this.screenshotQueue.shift()
                    // no request is wating, just return and release the page
                    if (!waitingPage) {
                        pageObj.isUsing = false
                        return
                    }
                } while (waitingPage.alreadyReject === true)
                // stop reject timer and assign page
                clearTimeout(waitingPage.rejectTimer)
                waitingPage.resolve(pageObj)
            }
        })
    }

    getIdlePage () {
        return new Promise(async (resolve, reject) => {
            const page = this.pagePool.find(pageInPool => {
                return pageInPool.isUsing === false
            })
            // if no available page and have free memory, allocate
            // otherwise, wait for several seconds until there is an idle page or timeout
            if (page) {
                page.isUsing = true
                resolve(page)
                return
            } else if (this.pageCount < PAGE_POOL_LIMIT) {
                this.logger(`[Get Idle Page]Create new page, current Pages: ${this.pageCount}`)
                this.pageCount += 1
                const newPage = {
                    isUsing: true,
                    page: await this.browser.newPage()
                }
                await Promise.all([
                    newPage.page.setJavaScriptEnabled(false),
                    newPage.page.setExtraHTTPHeaders({
                        'referer': 'https://h5.qzone.qq.com'
                    })
                ])
                await newPage.page.goto(`about:blank`)
                this.pagePool.push(newPage)
                resolve(newPage)
                return
            } else {
                this.logger(`[Get Idle Page]No available page, push in queue`)
                const queueObj = {
                    resolve,
                    alreadyReject: false,
                    rejectTimer: null
                }
                const newQueueLength = this.screenshotQueue.push(queueObj)
                queueObj.rejectTimer = setTimeout(_ => {
                    reject('[Get Idle Page]No available page!')
                    queueObj.alreadyReject = true
                    return
                }, MAX_IN_QUEUE_TIME)
            }
        })
    }

    async fromHtmlString (html, opts = {}, disableRetry) {
        return new Promise(async (resolve, reject) => {
            this.logger(`[Static Screenshot]Start ScreenShot From HTML Service`)
            
            let pageObj = null
            try {
                pageObj = await this.getIdlePage()
            } catch (e) {
                this.logger(`[Static Screenshot]get idle page error: ${e}`)
                reject({
                    code: -1001,
                    message:`get idle page error: ${e}`
                })
                return
            }
            let page = pageObj.page
            this.logger(`[Static Screenshot]Get Puppeteer Page Finish`)

            let picBuffer = null
            try {
                if (opts.viewport) {
                    await page.setViewport(opts.viewport)
                }

                // wrap the goto method to avoid the request hangs on
                await this.pageLoad(page, html)
                // await page.goto(`data:text/html,${html}`, {
                //     waitUntil: 'load',
                //     timeout: 3000
                // })
                this.logger(`[Static Screenshot]Set Page Content Finish`)

                // can set delay to wait for rendering finish (if using background-image)
                if (opts.delayAfterNavigate) {
                    await this.sleep(opts.delayAfterNavigate)
                }
    
                picBuffer = await page.screenshot({
                    type: opts.type || 'png',
                    quality: opts.quality,
                    omitBackground: opts.type === 'jpeg' ? false : true
                })
                this.logger(`[Static Screenshot]Generate Screenshot Finish`)
            } catch (e) {
                // release page source
                await this.releasePage(pageObj, true)
                this.logger(`[Static Screenshot]Error detected: ${e}`)

                // retry when failed firstly
                if (disableRetry === true) {
                    reject({
                        code: -1002,
                        message:`Navigate and Screenshot Error: ${e}`
                    })
                    return
                } else {
                    let result = null
                    try {
                        result = await this.fromHtmlString(html, opts, true)
                    } catch (e) {
                        reject(e)
                        return
                    }
                    resolve(result)
                    return
                }
            }

            // release page source
            await this.releasePage(pageObj)

            if (!opts.uploadToAlbum) {
                resolve(picBuffer)
                return
            } else {
                this.uploadParams.file_len = picBuffer.length
                const {uin , pSkey} = opts
                this.uploadParams.uin = String(uin)
                this.uploadParams.token.data = Buffer.from(String(uin))
                this.uploadParams.token.ext_key = Buffer.from(String(pSkey))
                let albumInfo = ''
                try {
                    albumInfo = await this.uploadBufferToAlbum(picBuffer)
                } catch (e) {
                    reject({
                        code: Number('-1003' + Math.abs(e.code)),
                        message:`Upload Error: ${e}`
                    })
                    return
                }
                resolve(albumInfo)
                return
            }
        })
    }

    async pageLoad (page, html) {
        try {
            await page.goto(`data:text/html,${html}`, {
                waitUntil: 'load',
                timeout: 3000
            })
        } catch (e) {
            // requests may hang on and exceed time limit, just return
        }
        return true
    }

    sleep (ms) {
        return new Promise(resolve => {
            setTimeout(_ => {
                resolve(true)
            }, ms)
        })
    }
    
    releasePage(pageObj, pageError) {
        /** Note: Since bug of puppeteer itself, we cannot load different page directly
         *  see Issues # 1159
         */
        return new Promise(async resolve => {
            if (pageError === true) {
                // attempt to kill page
                try {
                    await pageObj.page.close()
                } catch (e) {}
                // create new page
                pageObj.page = await this.browser.newPage()
                await Promise.all([
                    pageObj.page.setJavaScriptEnabled(false),
                    pageObj.page.setExtraHTTPHeaders({
                        'referer': 'https://h5.qzone.qq.com'
                    })
                ])
            }

            await pageObj.page.goto(`about:blank`)
            this.logger(`[Static Screenshot]Set page to blank`)
            pageObj.isUsing = false
            this.screenshotQueueEmitter.emit('release')
            resolve(true)
        })
    }

    generateGif (baseHtml, opts = {}, gifSlots = [], gifOptions = {}) {
        return new Promise(async (resolve, reject) => {
            this.logger(`[GIF Generator]Start Gif Generator Services`)
            if (gifSlots.length > GIF_MAX_FRAMES) {
                reject({
                    code: -3001,
                    message: `Exceed maximum frame limit`
                })
                return
            }

            let jpgBuffers = null
            try {
                jpgBuffers = await this.generateJPEGBufferGroups(baseHtml, gifSlots, opts.viewport)
            } catch (e) {
                reject({
                    code: -3002,
                    message: e
                })
                return
            }

            let gifBuffer = null
            try {
                this.logger(`[GIF Generator]generateGIF begin`)
                gifBuffer = await gifMaker.picsToGIF(jpgBuffers, {...gifOptions, height: opts.viewport.height, width: opts.viewport.width})
                this.logger(`[GIF Generator]generateGIF finish`)
            } catch (e) {
                reject({
                    code: -3004,
                    message: `Generate GIF Error: ${e}`
                })
                return
            }
            this.logger(`[GIF Generator]Gif generate finish`)

            // upload to album
            this.uploadParams.file_len = gifBuffer.length
            const {uin , pSkey} = opts
            this.uploadParams.uin = String(uin)
            this.uploadParams.token.data = Buffer.from(String(uin))
            this.uploadParams.token.ext_key = Buffer.from(String(pSkey))
            let albumInfo = ''
            try {
                albumInfo = await this.uploadBufferToAlbum(gifBuffer)
            } catch (e) {
                reject({
                    code: -3005,
                    message:`Upload Error: ${e}`
                })
                return
            }
            resolve(albumInfo)
        })
    }

    generateJPEGBufferGroups (baseHtml, slots, viewport) {
        return new Promise(async (resolve,reject) => {
            const htmlGroups = slots.map(slot => {
                return baseHtml.replace(`<!-- gif-slot -->`, slot)
            })
            const screenshotQueue = []
            htmlGroups.forEach(html => {
                screenshotQueue.push(this.fromHtmlString(html, {
                    viewport,
                    type: 'jpeg',
                    quality: 90
                }))
            })
            let jpgBuffers = null
            try {
                jpgBuffers = await Promise.all(screenshotQueue)
            } catch (e) {
                reject(e)
                return
            }
            resolve(jpgBuffers)
        })
    }

    uploadBufferToAlbum (picBuffer) {
        return new Promise((resolve, reject) => {
            const up = new Uploader(this.uploadParams)

            up.on('response', d => {
                this.logger(`Upload To Album Finish`)
                if (d && d.data) {
                    resolve(d && d.data)
                } else {
                    reject({
                        code: d.ret || d.code,
                        message: 'upload error with no data received'
                    })
                }
                return
            })

            up.end(picBuffer)
        })
    }
}

// 启动任务队列, 在服务器重启时, 只启动一个chrome, 其他请求等待该chrome启动完毕
let isLaunchingChrome = false
const waitingChromeResolveQueue = []
const launchChromeEventEmitter = new ScreenshotQueueEmitter()
// 启动完毕, 所有等待中的请求返回启动的chrome实例
launchChromeEventEmitter.on('finish', _ => {
    isLaunchingChrome = false
    waitingChromeResolveQueue.forEach(resolve => {
        resolve(chromeInstance)
    })
})
const htmlCliperFactory = (opts = {}) => {
    let {logger = _ => {}} = opts
    return new Promise(async (resolve, reject) => {
        if (chromeInstance) {
            resolve(chromeInstance)
        } else {
            // 防止多个chrome启动导致内存泄露. 队列系统
            if (isLaunchingChrome === true) {
                waitingChromeResolveQueue.push(resolve)
                return
            }
            isLaunchingChrome = true

            logger(`First call, launch chrome`)
            let browser = null
            try {
                browser = await puppeteer.launch({
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
                    ignoreHTTPSErrors: true,
                    headless: opts.headless
                })
            } catch (e) {
                logger(`Launch chrome fail!`)
                reject(`Launch Chrome Error: ${e}`)
                return
            }
            logger(`Launch chrome success!`)
            // chrome crash重启
            browser.on('disconnected', _ => {
                chromeInstance = null
            })

            // init pagePool
            let pagePool = []
            
            const createPagesQueue = []
            const createPage = _ => {
                return new Promise(async resolve => {
                    const page = await browser.newPage()
                    await Promise.all([
                        page.setJavaScriptEnabled(false),
                        page.setExtraHTTPHeaders({
                            'referer': 'https://h5.qzone.qq.com'
                        })
                    ])
                    await page.goto(`about:blank`)
                    pagePool.push({
                        isUsing: false,
                        page
                    })
                    resolve(true)
                })
            }
            for (let i = 0; i < PAGE_POOL_LIMIT; i++) {
                createPagesQueue.push(createPage())
            }
            await Promise.all(createPagesQueue)

            chromeInstance = new htmlCliper({
                browser,
                pagePool,
                logger
            })
            // 启动完毕, 通知等待中的请求
            launchChromeEventEmitter.emit('finish')
            // For worker process, terminate chrome when services reload
            if (cluster.isWorker) {
                cluster.worker.on('disconnect', async _ => {
                    await browser.close()
                })
            }

            resolve(chromeInstance)
        }
    })
}

module.exports = htmlCliperFactory