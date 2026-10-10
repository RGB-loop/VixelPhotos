/**
 * electron-builder afterPack：没有 Developer ID 证书时给 .app 做 ad-hoc 签名。
 *
 * 打包会改 Electron.app（Info.plist、资源），原签名失效；Apple Silicon 上不重签会报"已损坏"。
 * ad-hoc 签名（codesign --sign -）不需要开发者账号，用户首次打开在
 * 系统设置 → 隐私与安全性 里点"仍要打开"即可。有正式证书时设 CSC_NAME / CSC_LINK，这里自动跳过。
 */
const { execFileSync } = require('child_process')
const { join } = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_NAME || process.env.CSC_LINK) return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = join(__dirname, 'entitlements.mac.plist')
  console.log(`  • ad-hoc signing  ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
