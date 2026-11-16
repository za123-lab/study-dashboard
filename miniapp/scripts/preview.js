/**
 * 生成小程序「开发版」预览二维码（不上传、不影响线上版本）。
 *
 * 用法（在 miniapp/ 目录）：
 *   MINIPROGRAM_PRIVATE_KEY="C:/path/to/private.<appid>.key" npm run preview
 *
 * 密钥来自微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传密钥。
 * 只从环境变量读取，绝不写进仓库；AppID 从 project.private.config.json 读（本地忽略提交）。
 * 二维码默认输出到仓库根的 .screenshots/preview-qr.jpg。
 */
const fs = require('fs')
const path = require('path')
const ci = require('miniprogram-ci')

const ROOT = path.resolve(__dirname, '..')
const REPO = path.resolve(ROOT, '..')
const APPID = process.env.MINIPROGRAM_APPID || 'wxda700742e96716d0'
const KEY = process.env.MINIPROGRAM_PRIVATE_KEY
const OUT = process.env.PREVIEW_QR_DEST || path.join(REPO, '.screenshots', 'preview-qr.jpg')
const DESC = process.env.PREVIEW_DESC || '今日一页 · 开发版预览'

if (!KEY) {
  console.error('缺少 MINIPROGRAM_PRIVATE_KEY：请先设置上传密钥路径再运行。')
  process.exit(1)
}
if (!fs.existsSync(path.resolve(KEY))) {
  console.error('上传密钥文件不存在：' + KEY)
  process.exit(1)
}
if (!fs.existsSync(path.join(ROOT, 'dist', 'app.json'))) {
  console.error('未找到 dist/app.json，请先执行 npm run build:weapp。')
  process.exit(1)
}

const project = new ci.Project({
  appid: APPID,
  type: 'miniProgram',
  projectPath: path.join(ROOT, 'dist'),
  privateKeyPath: path.resolve(KEY),
  ignores: ['node_modules/**/*'],
})

const setting = { es6: true, minify: true, autoPrefixWXSS: true }

ci.preview({
  project,
  desc: DESC,
  setting,
  qrcodeFormat: 'image',
  qrcodeOutputDest: OUT,
  onProgressUpdate: function (t) {
    if (t && t._msg) console.log('[preview]', t._msg)
  },
})
  .then(function () {
    console.log('PREVIEW_OK ' + OUT)
  })
  .catch(function (e) {
    console.error('FAILED:', (e && e.message) || e)
    if (e && e.errCode) console.error('errCode:', e.errCode)
    process.exit(1)
  })
