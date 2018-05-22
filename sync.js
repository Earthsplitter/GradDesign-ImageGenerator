const gzipHttp 	= plug('util/gzipHttp.js')
const QzoneLogger = plug('logger')
const htmlCliperFactory = require('./picGenerator')
const config = plug('config')
const hybrid = require('qz')
const dcapi = plug('api/libdcapi/dcapi.js')
const serverInfo = plug('serverInfo.js')
const CacheServer = require('./cache')

const ERROR_CODE = {
    PARAM_ERROR: -1,
    CHROME_FATAL_ERROR: -2,
    CHROME_INIT_ERROR: -3
}

const SUCCESS_CODE = {
    pic: 0,
    cache: 1,
    gif: 2
}

const responseWithJSON = (request, response, data) => {
    const gzipResponse = gzipHttp.getGzipResponse({
        request: request,
        response: response,
        code: 200,
        contentType: 'text/json; charset=UTF-8'
    })
    gzipResponse.end(JSON.stringify(data))
}

const reportStat = (code, delay, interfaceId) => {
    dcapi.report({
        fromId: 211006089,
        toId: 211006088,
        interfaceId: interfaceId || 111900656,
        toIp: serverInfo.intranetIp,
        code,
        isFail: code < 0 ? 1 : 0,
        delay
    })
}

const logger = info => {
    QzoneLogger.debug(info)
}

const cacheServer = new CacheServer()

module.exports = async (req, res, plug) => {
    const startTimestamp = Date.now()
    const cmd = req.GET['cmd']
    let responseData = null
    const openCache = !(config.devMode || config.isTest) && req.POST['cache']

    // 缓存逻辑, 外网环境下如果请求开启缓存, 查看缓存
    if (openCache === true) {
        QzoneLogger.debug(`Cache is enabled`)
        const cmemReadStartTime = Date.now()
        // 读失败了回返回null, 没有必要try catch
        const hashData = await cacheServer.checkCache(req.POST)
        // 2 读成功(读不会失败只看延时)
        reportStat(2, Date.now() - cmemReadStartTime, 104982689)
        const responseNameMap = {
            'stringToBase64': 'base64',
            'stringToUrl': 'picUrl',
            'stringToGif': 'gifUrl'
        }
        let responseName = responseNameMap[cmd]
        if (hashData !== null) {
            QzoneLogger.debug(`Cache Hit`)
            reportStat(SUCCESS_CODE.cache, Date.now() - startTimestamp)
            responseWithJSON(req, res, {
                code: 0,
                [responseName]: hashData
            })
            return
        }
        QzoneLogger.debug(`Cache Miss`)
    }

    let chrome = null
    try {
        chrome = await htmlCliperFactory({
            logger,
            headless: !config.devMode
        })
    } catch (e) {
        reportStat(ERROR_CODE.CHROME_INIT_ERROR, Date.now() - startTimestamp)
        responseWithJSON(req, res, {
            code: ERROR_CODE.CHROME_INIT_ERROR,
            err: e
        })
        return
    }
    const htmlString = req.POST['html'] || ''
    const viewport = req.POST['viewport'] || {}
    const type = req.POST['type'] || ''
    const gifSlots = req.POST['gifSlots'] || []
    const gifOptions = req.POST['gifOptions'] || {}
    const delayAfterNavigate = Number(req.POST['delayAfterNavigate']) || null

    if (!htmlString) {
        reportStat(ERROR_CODE.PARAM_ERROR, Date.now() - startTimestamp)
        responseWithJSON(req, res, {
            code: ERROR_CODE.PARAM_ERROR,
            err: 'no htmlString'
        })
        return
    }

    if (cmd === 'stringToBase64') {
        try {
            responseData = (await chrome.fromHtmlString(htmlString, {
                viewport,
                type,
                delayAfterNavigate
            })).toString('base64')
        } catch (e) {
            logger(`Catch Error, Stop Service.`)
            reportStat(e.code || ERROR_CODE.CHROME_FATAL_ERROR, Date.now() - startTimestamp)
            responseWithJSON(req, res, {
                code: e.code || ERROR_CODE.CHROME_FATAL_ERROR,
                err: e
            })
            return
        }
        reportStat(SUCCESS_CODE.pic, Date.now() - startTimestamp)
        responseWithJSON(req, res, {
            code: 0,
            base64: responseData
        })
    } else if (cmd === 'stringToUrl') {
        try {
            responseData = await chrome.fromHtmlString(htmlString, {
                viewport,
                type,
                delayAfterNavigate,
                uploadToAlbum: true,
                uin: hybrid.user.getUin(),
                pSkey: hybrid.storage.cookie.get('p_skey')
            })
        } catch (e) {
            logger(`Catch Error, Stop Service.`)
            reportStat(e.code || ERROR_CODE.CHROME_FATAL_ERROR, Date.now() - startTimestamp)
            responseWithJSON(req, res, {
                code: e.code || ERROR_CODE.CHROME_FATAL_ERROR,
                err: e
            })
            return
        }
        reportStat(SUCCESS_CODE.pic, Date.now() - startTimestamp)
        responseWithJSON(req, res, {
            code: 0,
            picUrl: responseData
        })
    } else if (cmd === 'stringToGif') {
        try {
            responseData = await chrome.generateGif(htmlString, {
                viewport,
                uploadToAlbum: true,
                uin: hybrid.user.getUin(),
                pSkey: hybrid.storage.cookie.get('p_skey')
            }, gifSlots, gifOptions)
        } catch (e) {
            logger(`Catch Error, Stop Service.`)
            reportStat(e.code || ERROR_CODE.CHROME_FATAL_ERROR, Date.now() - startTimestamp)
            responseWithJSON(req, res, {
                code: e.code || ERROR_CODE.CHROME_FATAL_ERROR,
                err: e
            })
            return
        }
        reportStat(SUCCESS_CODE.gif, Date.now() - startTimestamp)
        responseWithJSON(req, res, {
            code: 0,
            gifUrl: responseData
        })
    } else {
        reportStat(-9999, Date.now() - startTimestamp)
        responseWithJSON(req, res, {
            code: -9999,
            message: 'No such command'
        })
        return
    }

    if (openCache === true) {
        QzoneLogger.debug(`write cache`)
        const cmemWriteStartTime = Date.now()
        try {
            await cacheServer.writeCache(req.POST, responseData)
        } catch (e) {
            logger(`Cmem Write Error`)
            // -1 写失败
            reportStat(-1, Date.now() - cmemWriteStartTime, 104982689)
            return
        }
        // 1 写成功
        reportStat(1, Date.now() - cmemWriteStartTime, 104982689)
    }
}