const http = require('http')
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

const WHACENTER_DEVICE_ID = '550fd04ee9fc7c4b4e057d0bce6270f3'

let browser = null

async function getBrowser() {
  if (!browser) {
    const launchOptions = {
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
    }
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    }
    browser = await chromium.launch(launchOptions)
  }
  return browser
}

const DEPLOY_VERSION = 'v5-only-shell-20260616'

// Cek chromium via folder existence — robust untuk semua nama folder:
// chromium-1217, chromium_headless_shell-1217, dll.
function getChromiumStatus() {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(require('os').homedir(), '.cache', 'ms-playwright')
  try {
    if (!fs.existsSync(browsersPath)) {
      return { installed: false, reason: `browsersPath not found: ${browsersPath}` }
    }
    const dirs = fs.readdirSync(browsersPath)
    // Cek chromium_headless_shell-* DULU (yang dipakai Render Linux headless)
    // lalu fallback ke chromium-* (untuk non-headless / local dev)
    const shellDir = dirs.find(d => d.startsWith('chromium_headless_shell'))
    const chromiumDir = shellDir || dirs.find(d => d.startsWith('chromium'))
    if (!chromiumDir) {
      return { installed: false, reason: `no chromium* folder in ${browsersPath}. dirs: ${dirs.join(',')}` }
    }
    // Cek ada INSTALLATION_COMPLETE marker
    const completePath = path.join(browsersPath, chromiumDir, 'INSTALLATION_COMPLETE')
    const complete = fs.existsSync(completePath)
    return {
      installed: complete,
      dir: chromiumDir,
      shellDir: shellDir || null,
      completePath,
      complete,
      allDirs: dirs,
      reason: complete ? 'OK' : `INSTALLATION_COMPLETE not found in ${chromiumDir}`
    }
  } catch(e) {
    return { installed: false, reason: e.message }
  }
}

function isChromiumInstalled() {
  const status = getChromiumStatus()
  console.log(`[chromium] status:`, JSON.stringify(status))
  return status.installed
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3001')

  if (req.method === 'GET' && url.pathname === '/health') {
    const status = getChromiumStatus()
    res.writeHead(200, {'Content-Type':'application/json'})
    res.end(JSON.stringify({ ok: true, chromiumReady: status.installed, chromiumStatus: status, version: DEPLOY_VERSION }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/version') {
    res.writeHead(200, {'Content-Type':'application/json'})
    res.end(JSON.stringify({ version: DEPLOY_VERSION, chromium: getChromiumStatus() }))
    return
  }

  // Debug endpoint: introspect dari dalam proses Render
  if (req.method === 'GET' && url.pathname === '/api/debug') {
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ||
      path.join(require('os').homedir(), '.cache', 'ms-playwright')
    let dirContents = []
    let chromiumDirContents = []
    let execPath = ''
    try { execPath = chromium.executablePath() } catch(e) { execPath = e.message }
    try { dirContents = fs.readdirSync(browsersPath) } catch(e) { dirContents = [e.message] }
    // List isi folder chromium* jika ada
    const chromiumDir = dirContents.find && dirContents.find(d => typeof d === 'string' && d.startsWith('chromium'))
    if (chromiumDir) {
      try { chromiumDirContents = fs.readdirSync(path.join(browsersPath, chromiumDir)) } catch(e) { chromiumDirContents = [e.message] }
    }
    res.writeHead(200, {'Content-Type':'application/json'})
    res.end(JSON.stringify({
      version: DEPLOY_VERSION,
      executablePath: execPath,
      browsersPath,
      NODE_ENV: process.env.NODE_ENV,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      dirContents,
      chromiumDir,
      chromiumDirContents
    }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/screenshot-hop') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const { tanggal, origin } = JSON.parse(body || '{}')
        const baseUrl = origin || 'https://mesin-monitor.pages.dev'
        const tgl = tanggal || new Date().toISOString().split('T')[0]

        // Ambil data stok
        const apiRes = await fetch(`${baseUrl}/api/data-stok?tanggal=${tgl}`)
        const apiJson = await apiRes.json()
        if (!apiJson.success || !apiJson.data?.length) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, error: `Data stok kosong untuk tanggal ${tgl}` }))
          return
        }
        const rows = apiJson.data

        // Ambil data HOP info
        let hopMap = {}
        try {
          const hopRes = await fetch(`${baseUrl}/api/hop-info`)
          const hopJson = await hopRes.json()
          if (hopJson.success && hopJson.data) hopMap = hopJson.data
        } catch(e) {}

        const BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
        const tglFmt = tgl.split('-').reverse().join('.')

        function fmtNum(val) {
          if (val === null || val === undefined) return '<span style="color:#94a3b8">—</span>'
          return Number(val).toLocaleString('id-ID')
        }
        function fmtEst(s) {
          if (!s) return '—'
          const p = s.split('-')
          return parseInt(p[2],10) + ' ' + BULAN[parseInt(p[1],10)-1]
        }

        let rows_html = ''
        rows.forEach((d, i) => {
          const ku = d.kode_unit
          const hopInfo = hopMap[ku] || {}
          const kondisiColor = d.kondisi_stock === 'KRITIS' ? '#ef4444'
                             : d.kondisi_stock === 'SIAGA'  ? '#eab308'
                             : d.kondisi_stock === 'AMAN'   ? '#22c55e'
                             : '#475569'
          const ssBg = d.safety_stock == null    ? ''
                     : d.safety_stock < 5         ? 'background:#ef4444;color:#fff;'
                     : d.safety_stock <= 7        ? 'background:#eab308;color:#fff;'
                     :                              'background:#22c55e;color:#fff;'
          const uldColor = (d.stok_awal === null || d.stok_awal === undefined) ? '#cbd5e1' : '#1e3a5f'
          const rowBg    = i % 2 === 0 ? '#ffffff' : '#f8fafc'
          const showHop  = d.safety_stock != null && d.safety_stock < 8

          const p = 'padding:4px 6px;'
          rows_html += `<tr style="background:${rowBg};">
            <td style="${p}text-align:center;">${i+1}</td>
            <td style="${p}font-weight:600;color:${uldColor};white-space:nowrap;">${d.nama_unit}</td>
            <td style="${p}white-space:nowrap;">${d.jalur||'—'}</td>
            <td style="${p}text-align:right;">${fmtNum(d.kapasitas_tangki)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.stok_awal_bulan)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.saldo_akhir)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.stock_mati)}</td>
            <td style="${p}text-align:right;font-weight:600;">${fmtNum(d.stock_bersih)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.pemakaian_bbm)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.pemakaian_rata_rata)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.rata_rata_harian)}</td>
            <td style="${p}text-align:right;">${d.daya_tampung_storage!=null ? Math.round(d.daya_tampung_storage*100)+'%' : '—'}</td>
            <td style="${p}text-align:right;font-weight:600;">${fmtNum(d.bbm_siap_kirim)}</td>
            <td style="${p}text-align:right;font-weight:600;${ssBg}">${fmtNum(d.safety_stock)}</td>
            <td style="${p}text-align:center;">${fmtEst(d.estimasi_bbm_habis)}</td>
            <td style="${p}text-align:center;font-weight:700;color:${kondisiColor};">${d.kondisi_stock||'—'}</td>
            <td style="${p}text-align:center;color:#475569;">${showHop?(hopInfo.posisi_terakhir||'—'):'—'}</td>
            <td style="${p}text-align:center;color:#475569;">${showHop?(hopInfo.estimasi_tiba||'—'):'—'}</td>
            <td style="${p}text-align:right;">${fmtNum(d.total_penerimaan)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.total_pemakaian)}</td>
          </tr>`
        })

        const th = 'background:#1e3a5f;color:#fff;padding:6px 6px;text-align:center;white-space:nowrap;border-right:1px solid #4a7ab5;'

        const now = new Date()
        const tsStr = now.toLocaleString('id-ID', { timeZone:'Asia/Jakarta', hour12:false })
          .replace(',','')
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;font-size:11px;}
body{background:#f1f5f9;padding:10px;display:inline-block;}
.wrap{background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.12);display:inline-block;}
.title{background:#1e3a5f;color:#fff;padding:8px 12px;font-size:13px;font-weight:700;display:flex;justify-content:space-between;align-items:center;}
.title-ts{font-size:9px;color:#94a3b8;font-weight:400;margin-left:16px;white-space:nowrap;}
.sub{background:#1e3a5f;color:#94a3b8;padding:1px 12px 7px;font-size:10px;}
table{border-collapse:collapse;width:auto;}
td{border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;}
td:last-child{border-right:none;}
tr:last-child td{border-bottom:none;}
</style></head><body>
<div class="wrap">
  <div class="title">
    <span>📊 HOP BBM KALSELTENG — ${tglFmt}</span>
    <span class="title-ts">dibuat: ${tsStr} WIB</span>
  </div>
  <div class="sub">Data stok &amp; estimasi BBM per ULD (H-1) · AMC UID KASELTENG</div>
  <table>
    <thead><tr>
      <th style="${th}">NO</th>
      <th style="${th}text-align:left;">ULD</th>
      <th style="${th}text-align:left;">JALUR</th>
      <th style="${th}">KAP.</th>
      <th style="${th}">SALDO<br>AWL BLN</th>
      <th style="${th}">SALDO<br>AKHIR</th>
      <th style="${th}">STK<br>MATI</th>
      <th style="${th}">STK<br>BERSIH</th>
      <th style="${th}">PAKAI<br>BBM</th>
      <th style="${th}">PAKAI<br>RATA</th>
      <th style="${th}">PAKAI<br>TRTNG</th>
      <th style="${th}">DAYA<br>TAMP.</th>
      <th style="${th}">BBM<br>SIAP</th>
      <th style="${th}">SAFETY<br>STOCK</th>
      <th style="${th}">EST.<br>HABIS</th>
      <th style="${th}">KONDISI<br>STOCK</th>
      <th style="${th}">POSISI<br>TRKHR</th>
      <th style="${th}">EST.<br>TIBA</th>
      <th style="${th}">TOT<br>TRIMA</th>
      <th style="${th}border-right:none;">TOT<br>PAKAI</th>
    </tr></thead>
    <tbody>${rows_html}</tbody>
  </table>
</div></body></html>`

        const br = await getBrowser()
        const ctx = await br.newContext({
          viewport: { width: 100, height: 100 },
          deviceScaleFactor: 2
        })
        const page = await ctx.newPage()
        await page.setContent(html, { waitUntil: 'networkidle' })
        await page.waitForTimeout(200)

        const el  = await page.$('.wrap')
        const box = await el.boundingBox()
        await page.setViewportSize({
          width:  Math.ceil(box.width  + box.x * 2),
          height: Math.ceil(box.height + box.y * 2)
        })

        const shot = await el.screenshot({ type: 'png' })
        await ctx.close()

        const { nomor, group, message: waMsg, callbackUrl } = JSON.parse(body || '{}')

        const b64 = shot.toString('base64')
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ success: true, queued: true }))

        if (nomor || group) {
          ;(async () => {
            let waResult = null
            let imgUrl = ''
            try {
              const tglFmt = tgl.split('-').reverse().join('.')
              const caption = waMsg || `📊 *HOP BBM KALSELTENG — ${tglFmt}*\nData stok & estimasi BBM per ULD (data H-1)\n_AMC UID KASELTENG_`

              try {
                const upForm = new URLSearchParams()
                upForm.append('key', 'bb2f97ad9b31b5ae4967eeead61e03de')
                upForm.append('image', b64)
                upForm.append('name', `HOP_BBM_${tgl}_${Date.now()}`)
                const imgRes = await fetch('https://api.imgbb.com/1/upload', {
                  method: 'POST',
                  body: upForm
                })
                const imgJson = await imgRes.json()
                if (imgJson.success && imgJson.data?.url) {
                  imgUrl = imgJson.data.url
                  console.log(`[IMGBB] Upload OK → ${imgUrl}`)
                } else {
                  console.error(`[IMGBB] Upload FAIL: ${JSON.stringify(imgJson)}`)
                }
              } catch(e) {
                console.error(`[IMGBB] Error: ${e.message}`)
              }

              if (imgUrl) {
                const payload = {
                  device_id: WHACENTER_DEVICE_ID,
                  message: caption,
                  file: imgUrl
                }
                let waEndpoint = ''
                if (nomor) {
                  payload.number = nomor
                  waEndpoint = 'https://app.whacenter.com/api/send'
                } else {
                  payload.group = group
                  waEndpoint = 'https://app.whacenter.com/api/sendGroup'
                }
                const waRes = await fetch(waEndpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload)
                })
                waResult = await waRes.json()
                console.log(`[WA] ${tgl} → ${waResult?.status ? 'OK' : 'FAIL'} ${JSON.stringify(waResult)}`)
              } else {
                console.error(`[WA] Skip kirim — imgUrl kosong`)
                waResult = { error: 'imgUrl kosong, upload imgbb gagal' }
              }
            } catch(e) {
              console.error(`[WA] Error kirim: ${e.message}`)
              waResult = { error: e.message }
            }

            if (waResult?.status && callbackUrl) {
              try {
                await fetch(callbackUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tanggal: tgl, status: 'sent' })
                })
                console.log(`[CB] Callback OK → ${callbackUrl}`)
              } catch(e) { console.error(`[CB] Callback error: ${e.message}`) }
            }
          })()
        }

      } catch(e) {
        if (!res.headersSent) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, error: e.message }))
        } else {
          console.error('[screenshot-hop] Error after response sent:', e.message)
        }
      }
    })
    return
  }

  // ── /screenshot — screenshot tabel Neraca Daya ──────────────────────────
  if (req.method === 'POST' && url.pathname === '/screenshot') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const { tanggal, origin } = JSON.parse(body || '{}')
        const baseUrl = origin || 'https://mesin-monitor.pages.dev'
        const tgl = tanggal || new Date().toISOString().split('T')[0]
        const tglFmt = tgl.split('-').reverse().join('.')

        const apiRes = await fetch(`${baseUrl}/api/neraca-daya?tanggal=${tgl}`)
        const apiJson = await apiRes.json()
        if (!apiJson.success || !apiJson.data?.length) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, error: `Data neraca kosong untuk tanggal ${tgl}` }))
          return
        }
        const rows = apiJson.data

        function fmtNum(val) {
          if (val === null || val === undefined || val === 0) return '<span style="color:#94a3b8">—</span>'
          return Number(val).toLocaleString('id-ID')
        }
        function fmtN0(val) {
          if (val === null || val === undefined) return '—'
          return Number(val).toLocaleString('id-ID')
        }

        let totMaks=0, totBpSiang=0, totCadSiang=0, totBpMalam=0, totCadMalam=0
        let totOps=0, totStby=0, totPem=0, totGng=0, totRsk=0
        rows.forEach(d => {
          totMaks      += d.dm_terpasang||0
          totBpSiang   += d.beban_puncak_siang||0
          totCadSiang  += Math.max(0, (d.dm_pasok||0) - (d.beban_puncak_siang||0))
          totBpMalam   += d.beban_puncak_malam||0
          totCadMalam  += Math.max(0, (d.dm_pasok||0) - (d.beban_puncak_malam||0))
          totOps  += d.jumlah_operasi||0
          totStby += d.jumlah_standby||0
          totPem  += d.jumlah_pemeliharaan||0
          totGng  += d.jumlah_gangguan||0
          totRsk  += d.jumlah_rusak||0
        })

        let rows_html = ''
        rows.forEach((d, i) => {
          const rowBg = i % 2 === 0 ? '#ffffff' : '#f8fafc'
          const p = 'padding:5px 7px;'

          const cadSiang = (d.dm_pasok||0) - (d.beban_puncak_siang||0)
          const cadMalam = (d.dm_pasok||0) - (d.beban_puncak_malam||0)
          const maxDm    = d.max_dm||0
          const n1       = cadMalam - maxDm

          let statusLabel, statusBg, statusFg
          if (cadMalam < 0) {
            statusLabel = 'KRITIS'; statusBg = '#fee2e2'; statusFg = '#991b1b'
          } else if (cadMalam < maxDm) {
            statusLabel = 'SIAGA';  statusBg = '#fef3c7'; statusFg = '#92400e'
          } else {
            statusLabel = 'NORMAL'; statusBg = '#d1fae5'; statusFg = '#065f46'
          }

          rows_html += `<tr style="background:${rowBg};">
            <td style="${p}text-align:center;">${i+1}</td>
            <td style="${p}font-weight:600;white-space:nowrap;">${d.nama_unit}</td>
            <td style="${p}text-align:right;">${fmtN0(d.dm_terpasang)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.beban_puncak_siang)}</td>
            <td style="${p}text-align:right;">${fmtN0(cadSiang)}</td>
            <td style="${p}text-align:right;font-weight:600;">${fmtNum(d.beban_puncak_malam)}</td>
            <td style="${p}text-align:right;">${fmtN0(cadMalam < 0 ? 0 : cadMalam)}</td>
            <td style="${p}text-align:right;font-weight:600;">${n1}</td>
            <td style="${p}text-align:center;">${d.jumlah_operasi||0}</td>
            <td style="${p}text-align:center;">${d.jumlah_standby||0}</td>
            <td style="${p}text-align:center;">${d.jumlah_pemeliharaan||0}</td>
            <td style="${p}text-align:center;">${d.jumlah_gangguan||0}</td>
            <td style="${p}text-align:center;">${d.jumlah_rusak||0}</td>
            <td style="${p}text-align:center;font-weight:700;background:${statusBg};color:${statusFg};">${statusLabel}</td>
          </tr>`
        })

        const totN1 = totCadMalam - (rows.reduce((s,d)=>s+(d.max_dm||0),0))
        rows_html += `<tr style="background:#1e3a5f;color:#fff;font-weight:700;">
          <td colspan="2" style="padding:5px 7px;text-align:center;">TOTAL</td>
          <td style="padding:5px 7px;text-align:right;">${totMaks.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">${totBpSiang.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">${totCadSiang.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">${totBpMalam.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">${totCadMalam.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">${totN1.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:center;">${totOps}</td>
          <td style="padding:5px 7px;text-align:center;">${totStby}</td>
          <td style="padding:5px 7px;text-align:center;">${totPem}</td>
          <td style="padding:5px 7px;text-align:center;">${totGng}</td>
          <td style="padding:5px 7px;text-align:center;">${totRsk}</td>
          <td style="padding:5px 7px;"></td>
        </tr>`

        const th = 'background:#1e3a5f;color:#fff;padding:6px 7px;text-align:center;white-space:nowrap;border-right:1px solid #4a7ab5;'
        const now = new Date()
        const tsStr = now.toLocaleString('id-ID', { timeZone:'Asia/Jakarta', hour12:false }).replace(',','')

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;font-size:11px;}
body{background:#f1f5f9;padding:10px;display:inline-block;}
.wrap{background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.12);display:inline-block;}
.title{background:#1e3a5f;color:#fff;padding:8px 12px;font-size:13px;font-weight:700;display:flex;justify-content:space-between;align-items:center;}
.title-ts{font-size:9px;color:#94a3b8;font-weight:400;margin-left:16px;white-space:nowrap;}
.sub{background:#1e3a5f;color:#94a3b8;padding:1px 12px 7px;font-size:10px;}
table{border-collapse:collapse;width:auto;}
td{border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;}
td:last-child{border-right:none;}
tr:last-child td{border-bottom:none;}
</style></head><body>
<div class="wrap">
  <div class="title">
    <span>⚡ NERACA DAYA KALSELTENG — ${tglFmt}</span>
    <span class="title-ts">dibuat: ${tsStr} WIB</span>
  </div>
  <div class="sub">Data beban puncak malam seluruh ULD · AMC UID KASELTENG</div>
  <table>
    <thead><tr>
      <th style="${th}">NO</th>
      <th style="${th}text-align:left;">ULD</th>
      <th style="${th}">MAKS</th>
      <th style="${th}">BP<br>SIANG</th>
      <th style="${th}">CAD<br>SIANG</th>
      <th style="${th}">BP<br>MALAM</th>
      <th style="${th}">CAD<br>MALAM</th>
      <th style="${th}">N-1</th>
      <th style="${th}">OPS</th>
      <th style="${th}">STBY</th>
      <th style="${th}">PEM</th>
      <th style="${th}">GNG</th>
      <th style="${th}">RSK</th>
      <th style="${th}border-right:none;">STATUS</th>
    </tr></thead>
    <tbody>${rows_html}</tbody>
  </table>
</div></body></html>`

        const br = await getBrowser()
        const ctx = await br.newContext({ viewport:{ width:100, height:100 }, deviceScaleFactor:2 })
        const page = await ctx.newPage()
        await page.setContent(html, { waitUntil:'networkidle' })
        await page.waitForTimeout(200)
        const el  = await page.$('.wrap')
        const box = await el.boundingBox()
        await page.setViewportSize({ width: Math.ceil(box.width+box.x*2), height: Math.ceil(box.height+box.y*2) })
        const shot = await el.screenshot({ type:'png' })
        await ctx.close()

        const b64 = shot.toString('base64')
        const { nomor, group, message: waMsg, callbackUrl } = JSON.parse(body || '{}')

        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ success: true, queued: true }))

        if (nomor || group) {
          ;(async () => {
            let waResult = null
            let imgUrl = ''
            try {
              try {
                const upForm = new URLSearchParams()
                upForm.append('key',   'bb2f97ad9b31b5ae4967eeead61e03de')
                upForm.append('image', b64)
                upForm.append('name',  `NERACA_${tgl}_${Date.now()}`)
                const imgRes  = await fetch('https://api.imgbb.com/1/upload', { method:'POST', body: upForm })
                const imgJson = await imgRes.json()
                if (imgJson.success && imgJson.data?.url) {
                  imgUrl = imgJson.data.url
                  console.log(`[IMGBB-NERACA] Upload OK → ${imgUrl}`)
                } else {
                  console.error(`[IMGBB-NERACA] FAIL: ${JSON.stringify(imgJson)}`)
                }
              } catch(e) { console.error(`[IMGBB-NERACA] Error: ${e.message}`) }

              if (imgUrl) {
                const caption = waMsg || `⚡ *NERACA DAYA KALSELTENG — ${tglFmt}*\nData beban puncak malam seluruh ULD\n_AMC UID KASELTENG_`
                const payload = { device_id: WHACENTER_DEVICE_ID, message: caption, file: imgUrl }
                let waEndpoint = ''
                if (nomor) { payload.number = nomor; waEndpoint = 'https://app.whacenter.com/api/send' }
                else       { payload.group  = group;  waEndpoint = 'https://app.whacenter.com/api/sendGroup' }
                const waRes = await fetch(waEndpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload)
                })
                waResult = await waRes.json()
                console.log(`[WA-NERACA] ${tgl} → ${waResult?.status ? 'OK' : 'FAIL'} ${JSON.stringify(waResult)}`)
              } else {
                console.error(`[WA-NERACA] Skip — imgUrl kosong`)
                waResult = { error: 'imgUrl kosong' }
              }
            } catch(e) {
              console.error(`[WA-NERACA] Error kirim: ${e.message}`)
              waResult = { error: e.message }
            }

            if (waResult?.status && callbackUrl) {
              try {
                await fetch(callbackUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tanggal: tgl, status: 'sent' })
                })
                console.log(`[CB-NERACA] Callback OK → ${callbackUrl}`)
              } catch(e) { console.error(`[CB-NERACA] Callback error: ${e.message}`) }
            }
          })()
        }

      } catch(e) {
        if (!res.headersSent) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, error: e.message }))
        }
      }
    })
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

const PORT = process.env.PORT || 3001
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Screenshot service running on :${PORT}`)

  // ── Install chromium di background setelah server start ──
  // Gunakan fs.existsSync(chromium.executablePath()) — lebih reliable dari --dry-run
  const { spawn } = require('child_process')

  // Pakai folder-based check — robust untuk semua varian nama folder chromium
  const chromiumStatus = getChromiumStatus()
  console.log(`[chromium] status: ${JSON.stringify(chromiumStatus)}`)

  if (chromiumStatus.installed) {
    console.log(`[chromium] Already installed ✓ (${chromiumStatus.dir})`)
  } else {
    console.log(`[chromium] Not found (${chromiumStatus.reason}), installing in background...`)
    // Render Linux headless pakai chromium_headless_shell — install dengan --only-shell
    const installProc = spawn('npx', ['playwright', 'install', '--only-shell', 'chromium'], {
      detached: true,
      stdio: 'inherit',
      env: { ...process.env }
    })
    installProc.unref()
    installProc.on('exit', (code) => {
      if (code === 0) {
        console.log('[chromium] Install DONE ✓ — ready for screenshots')
      } else {
        console.error(`[chromium] Install FAILED (exit code ${code})`)
      }
    })
    installProc.on('error', (err) => {
      console.error(`[chromium] Install spawn error: ${err.message}`)
    })
  }

  // Self keep-alive setiap 14 menit (Render free spin-down = 15 menit idle)
  setInterval(async () => {
    try {
      await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(5000) })
    } catch(e) { /* ignore */ }
  }, 14 * 60 * 1000)
})
