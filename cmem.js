const logger = plug('logger')
const cmem = plug('pool/cmem.l5.js')
const config = plug('config')

const PREFIX = '__PIC_GENERATOR__';

const initCmem = _ => {
    return cmem(config.tswL5api['cmem.tsw.sz'])
}


const set = (params = {}) => {
    return new Promise((resolve, reject) => {
        if (!params.key) {
            reject(`Key is required`)
        }
        
        const key = PREFIX + params.key
        const expires = 4 * 3600                    // seconds
        const memcached = initCmem()

        logger.debug(`write cmem time: ${Date.now()}`)

        memcached.set(key, params.data, expires, err => {
            if (err) {
                logger.debug(`write cmem error: ${err}`)
    
                reject({
                    code: -11,
                    message: err
                })
                return
            }

            resolve({
                code: 0
            })
        })
    })
}

const get = (params = {}) => {
    return new Promise((resolve, reject) => {
        const key = PREFIX + params.key
        const memcached = initCmem()

        logger.debug(`get cmem time: ${Date.now()}`)

        memcached.get(key, (err, data) => {
            if (params.delete === true) {
                memcached.delete(key)
            }

            if (!data) {
                logger.debug(`get no data`)
                resolve({
                    code: -21,
                    message: 'no data',
                    data: null
                })
                return
            }

            if (err) {
                logger.debug(`get cmem error`)
                reject({
                    code: -22,
                    message: err
                })
                return
            }

            logger.debug(`get cmem content`)
            resolve({
                code: 0,
                data: data
            })
        })
    })
}

module.exports = {
    set,
    get
}
