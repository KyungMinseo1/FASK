// From desktop/: npx electron ../mobile/generate-icons.cjs
// Reuse the Windows artwork for launcher icons (adaptive foreground inside Android's safe zone) and splash screens.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
app.whenReady().then(async () => {
  try {
    const source = readFileSync(join(__dirname, '../desktop/build/icon.png')).toString('base64')
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await win.loadURL('data:text/html,<html></html>')
    const splashes = [
      ['drawable', 480, 320],
      ['drawable-land-mdpi', 480, 320], ['drawable-land-hdpi', 800, 480], ['drawable-land-xhdpi', 1280, 720],
      ['drawable-land-xxhdpi', 1600, 960], ['drawable-land-xxxhdpi', 1920, 1280],
      ['drawable-port-mdpi', 320, 480], ['drawable-port-hdpi', 480, 800], ['drawable-port-xhdpi', 720, 1280],
      ['drawable-port-xxhdpi', 960, 1600], ['drawable-port-xxxhdpi', 1280, 1920]
    ]
    const { assets, splash } = await win.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src = 'data:image/png;base64,${source}'; await image.decode();
      const assets = [1, 1.5, 2, 3, 4].map(scale => {
        const render = (adaptive, round) => {
          const size = Math.round((adaptive ? 108 : 48) * scale);
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (round) { ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, 2*Math.PI); ctx.clip(); ctx.fillStyle='#7567ef'; ctx.fillRect(0,0,size,size); }
          const edge = adaptive ? size * 66 / 108 : size;
          ctx.drawImage(image, (size-edge)/2, (size-edge)/2, edge, edge);
          return canvas.toDataURL('image/png').split(',')[1];
        };
        return [render(false, false), render(false, true), render(true, false)];
      });
      const splash = ${JSON.stringify(splashes)}.map(([, width, height]) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
        const edge = Math.round(Math.min(width, height) * 0.3);
        ctx.drawImage(image, (width-edge)/2, (height-edge)/2, edge, edge);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      return { assets, splash };
    })()`)
    const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']
    densities.forEach((density, i) => {
      ;['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground'].forEach((name, j) => {
        writeFileSync(join(__dirname, `android/app/src/main/res/mipmap-${density}/${name}.png`), Buffer.from(assets[i][j], 'base64'))
      })
    })
    splashes.forEach(([dir], i) => {
      writeFileSync(join(__dirname, `android/app/src/main/res/${dir}/splash.png`), Buffer.from(splash[i], 'base64'))
    })
    console.log('Android launcher icons (5 densities) and splash screens (11) generated from desktop/build/icon.png')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
