/**
 * Created by mingmwen.  Mar. 29 2018
 * 缓存系统, 对于缓存内的内容直接返回url
 * 直接和sync交互(请求命中缓存直接回), 不经过截图系统
 * 1. 封装了和cmem的交互
 * 2. 对请求字符串的hash
 */

const cmem = require('./cmem')
const hash = require('picGenerator/stringHash')
const CACHE_USE_LIMIT = 1000        // 一张图最多使用次数(考虑到相册的分布式特性), 概率抛弃

class cacheServer {
    constructor () {
        
    }

    calculateHash (object) {
        const objectString = JSON.stringify(object) 
        return hash(objectString)
    }

    checkCache (requestDataObject) {
        return new Promise(async (resolve, reject) => {
            const hash = this.calculateHash(requestDataObject)
            let data = null
            try {
                data = (await cmem.get({
                    key: hash
                })).data
            } catch (e) {
                resolve(null)
                return
            }
            // cache hit, judge if need to discard
            if (data !== null) {
                const probability = Math.random()
                if (probability < 1 / CACHE_USE_LIMIT) {
                    resolve(null)
                } else {
                    resolve(data)
                }
            } else {
                // cache miss
                resolve(null)
            }
        })
    }

    writeCache (requestDataObject, data) {
        return new Promise(async (resolve, reject) => {
            const hash = this.calculateHash(requestDataObject)
            try {
                const result = await cmem.set({
                    key: hash,
                    data
                })
            } catch (e) {
                reject(e)
                return
            }

            resolve(true)
        })
    }
}

module.exports = cacheServer