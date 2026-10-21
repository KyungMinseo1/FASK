// Run with Electron: npx electron build/generate-icons.cjs
// Reproduces the dashboard's Georgia italic f on its violet rounded tile.
const { app, BrowserWindow, nativeImage } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await win.loadURL('data:text/html,<html></html>')
    const png = Buffer.from(
      await win.webContents.executeJavaScript(`(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#7567ef'; ctx.beginPath(); ctx.roundRect(0, 0, 1024, 1024, 260); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.font = 'italic bold 900px Georgia'; ctx.textAlign = 'center';
      ctx.fillText('f', 505, 794);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`),
      'base64'
    )
    const image = nativeImage.createFromBuffer(png)
    writeFileSync(join(__dirname, 'icon.png'), png)
    writeFileSync(join(__dirname, '../resources/icon.png'), png)
    const sizes = [16, 32, 48, 64, 128, 256]
    const images = sizes.map((size) => image.resize({ width: size, height: size }).toPNG())
    const header = Buffer.alloc(6 + sizes.length * 16)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    sizes.forEach((size, i) => {
      const entry = 6 + i * 16
      header[entry] = header[entry + 1] = size % 256
      header.writeUInt16LE(1, entry + 4)
      header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(images[i].length, entry + 8)
      header.writeUInt32LE(offset, entry + 12)
      offset += images[i].length
    })
    writeFileSync(join(__dirname, 'icon.ico'), Buffer.concat([header, ...images]))
    const chunks = [
      [16, 'icp4'],
      [32, 'icp5'],
      [64, 'icp6'],
      [128, 'ic07'],
      [256, 'ic08'],
      [512, 'ic09'],
      [1024, 'ic10']
    ].map(([size, type]) => {
      const png = image.resize({ width: size, height: size }).toPNG()
      const header = Buffer.alloc(8)
      header.write(type)
      header.writeUInt32BE(8 + png.length, 4)
      return Buffer.concat([header, png])
    })
    const icnsHeader = Buffer.alloc(8)
    icnsHeader.write('icns')
    icnsHeader.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
    writeFileSync(join(__dirname, 'icon.icns'), Buffer.concat([icnsHeader, ...chunks]))
    if (image.isEmpty()) throw new Error('Icon generation failed')
    console.log('FASK icons generated: PNG, ICO (6 sizes), ICNS (7 sizes), runtime PNG')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
