/**
 * Created by mingmwen.  Mar. 29 2018
 * 静态工具库, 提供了两个工具函数
 * 1. jpeg格式解码到像素点
 * 2. 像素buffer数组编码为gif
 */

const GIFEncoder = require('picGenerator/gifEncoder.js')
const JPEG = require('picGenerator/jpegDecoder.js')
const stream = require('stream')
const platform = require('os').platform()
let GIFEncoderAddOn = {}

if (platform === 'linux') {
    GIFEncoderAddOn = plug('api/gifencoder/index')
} else if (platform === 'win32') {
    GIFEncoderAddOn = require('picGenerator/node_modules/gifencoder_addon/build/Release/gifNodeAddOn.node')
}



const decodeJPEG = jpgBuffer => {
    return JPEG.decode(jpgBuffer)
}

const decodeJPEGs = jpgBuffers => {
    const pixelBuffers = jpgBuffers.map(jpgBuffer => {
        return decodeJPEG(jpgBuffer).data
    })
    return pixelBuffers
}

const generateGIF = (pixelBuffers, options) => {
    return new Promise(resolve => {
        const height = options.height || 800
        const width = options.width || 600
        const quality = options.quality || 10
        const interval = options.interval || 800
        const repeat = options.repeat === true ? 0 : -1

        let gifBuf = Buffer.alloc(0)
        const encoder = new GIFEncoder(width, height)
        const readStream = encoder.createReadStream()

        readStream.on('data', data => {
            gifBuf = Buffer.concat([gifBuf, data]);
        })
        readStream.on('end', _ => {
            resolve(gifBuf)
        })

        encoder.start()
        encoder.setRepeat(repeat)
        encoder.setDelay(interval)
        encoder.setQuality(quality)

        pixelBuffers.forEach(pixelBuffer => {
            encoder.addFrame(pixelBuffer)
        })

        encoder.finish()
    })
}

const  picsToGIF = GIFEncoderAddOn.picsToGIF


module.exports = {
    decodeJPEG,
    decodeJPEGs,
    generateGIF,
    picsToGIF
}