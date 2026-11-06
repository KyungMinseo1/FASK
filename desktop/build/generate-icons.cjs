// Run with Electron: npx electron build/generate-icons.cjs
// Draws the FASK "f." mark: cream Pretendard 850 f + coral period on a navy tile.
// Also regenerates the Android launcher mipmaps in ../mobile/android.
const { app, BrowserWindow, nativeImage } = require('electron')
const { writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const NAVY = '#14213D'
const CREAM = '#F4EDE0'
const CORAL = '#FF6B5B'
const fontPath = join(__dirname, '../node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2')
const res = join(__dirname, '../../mobile/android/app/src/main/res')
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await win.loadURL('data:text/html,<html></html>')
    const font = readFileSync(fontPath).toString('base64')
    await win.webContents.executeJavaScript(`(async () => {
      const face = new FontFace('PretendardIcon', 'url(data:font/woff2;base64,${font})', { weight: '45 920' });
      await face.load(); document.fonts.add(face);
      // shape: 'tile' rounded square, 'circle', 'none' transparent; scale: mark height share of canvas
      window.drawMark = (size, shape, scale) => {
        const c = document.createElement('canvas'); c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '${NAVY}'; ctx.beginPath();
        if (shape === 'tile') { ctx.roundRect(0, 0, size, size, size * 0.254); ctx.fill(); }
        else if (shape === 'circle') { ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.fill(); }
        ctx.font = '850 ' + 100 + 'px PretendardIcon';
        const m = ctx.measureText('f.');
        const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
        const k = (size * scale) / h;
        ctx.font = '850 ' + (100 * k) + 'px PretendardIcon';
        const mm = ctx.measureText('f.');
        const w = mm.actualBoundingBoxLeft + mm.actualBoundingBoxRight;
        const x = (size - w) / 2 + mm.actualBoundingBoxLeft;
        const y = (size - (mm.actualBoundingBoxAscent + mm.actualBoundingBoxDescent)) / 2 + mm.actualBoundingBoxAscent;
        ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
        ctx.fillStyle = '${CREAM}'; ctx.fillText('f', x, y);
        ctx.fillStyle = '${CORAL}'; ctx.fillText('.', x + ctx.measureText('f').width, y);
        return c.toDataURL('image/png').split(',')[1];
      };
    })()`)
    const draw = async (size, shape, scale) =>
      Buffer.from(await win.webContents.executeJavaScript(`drawMark(${size}, '${shape}', ${scale})`), 'base64')
    const png = await draw(1024, 'tile', 0.62)
    const image = nativeImage.createFromBuffer(png)
    writeFileSync(join(__dirname, 'icon.png'), png)
    writeFileSync(join(__dirname, '../resources/icon.png'), png)
    const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
    for (const [d, f] of Object.entries(densities)) {
      const dir = join(res, `mipmap-${d}`)
      writeFileSync(join(dir, 'ic_launcher.png'), await draw(48 * f, 'tile', 0.62))
      writeFileSync(join(dir, 'ic_launcher_round.png'), await draw(48 * f, 'circle', 0.56))
      // 108dp canvas, 72dp visible, 66dp safe zone: mark height ~40% of canvas stays inside
      writeFileSync(join(dir, 'ic_launcher_foreground.png'), await draw(108 * f, 'none', 0.4))
    }
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
