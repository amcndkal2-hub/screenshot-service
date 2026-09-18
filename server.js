const http = require('http')
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

const WHACENTER_DEVICE_ID = '550fd04ee9fc7c4b4e057d0bce6270f3'  // fallback — akan ditimpa oleh kvGet
const IMGBB_API_KEY = 'bb2f97ad9b31b5ae4967eeead61e03de'
const CF_ORIGIN = 'https://mesin-monitor.pages.dev'

// ── Ambil device_id aktif dari CF Pages kv_store ──────────────────────────────
// Selalu fetch fresh saat dipanggil agar reflect update tanpa redeploy Render
async function fetchDeviceId() {
  try {
    const res = await fetch(`${CF_ORIGIN}/api/whacenter-device`, { signal: AbortSignal.timeout(5000) })
    const json = await res.json()
    if (json.device_id && json.device_id.length > 10) {
      console.log(`[device_id] Dari CF: ${json.device_id} (source: ${json.source})`)
      return json.device_id
    }
  } catch(e) {
    console.warn(`[device_id] Gagal fetch dari CF: ${e.message}, pakai fallback`)
  }
  return WHACENTER_DEVICE_ID
}

// ── Upload ke uguu.se (gratis, direct URL image/png, aktif 48 jam) ──
async function uploadImageUguu(buffer, filename) {
  const fname = filename || `img_${Date.now()}.png`
  const blob = new Blob([buffer], { type: 'image/png' })
  const form = new FormData()
  form.append('files[]', blob, fname)
  const res = await fetch('https://uguu.se/upload', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15000)
  })
  const json = await res.json()
  if (json.success && json.files?.[0]?.url) {
    // URL sudah direct image (d.uguu.se/xxx.png) — tidak perlu convert
    return json.files[0].url
  }
  throw new Error(`uguu upload failed: ${JSON.stringify(json)}`)
}

// ── Upload ke tmpfiles.org (gratis, reliable, URL aktif 60 menit) ──
async function uploadImageTmpfiles(buffer, filename) {
  const fname = filename || `img_${Date.now()}.png`
  const blob = new Blob([buffer], { type: 'image/png' })
  const form = new FormData()
  form.append('file', blob, fname)
  const res = await fetch('https://tmpfiles.org/api/v1/upload', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15000)
  })
  const json = await res.json()
  if (json.status === 'success' && json.data?.url) {
    // Convert view URL ke direct download URL
    return json.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/')
  }
  throw new Error(`tmpfiles upload failed: ${JSON.stringify(json)}`)
}

// ── Upload ke ImgBB (API key) ──
async function uploadImageImgBB(buffer, filename) {
  const fname = (filename || `img_${Date.now()}`).replace(/\.png$/, '')
  const b64 = buffer.toString('base64')
  const form = new URLSearchParams()
  form.append('key', IMGBB_API_KEY)
  form.append('image', b64)
  form.append('name', fname)
  const res = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15000)
  })
  const json = await res.json()
  if (json.success && json.data?.url) return json.data.url
  throw new Error(`imgbb upload failed: ${JSON.stringify(json.error || json)}`)
}

// ── Upload ke Litterbox (fallback terakhir) ──
async function uploadImageLitterbox(buffer, filename) {
  const fname = filename || `img_${Date.now()}.png`
  const blob = new Blob([buffer], { type: 'image/png' })
  const form = new FormData()
  form.append('reqtype', 'fileupload')
  form.append('time', '24h')
  form.append('fileToUpload', blob, fname)
  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15000)
  })
  const text = await res.text()
  if (text.startsWith('https://')) return text.trim()
  throw new Error(`litterbox upload failed: ${text.slice(0, 200)}`)
}

// Primary: uguu.se → Fallback: tmpfiles.org → Fallback: ImgBB
// uguu.se menghasilkan direct URL (d.uguu.se/xxx.png) tanpa redirect/cookie
async function uploadImage(buffer, filename) {
  // 1. Coba uguu.se (primary — direct URL, content-type: image/png)
  try {
    const url = await uploadImageUguu(buffer, filename)
    console.log(`[UPLOAD] uguu OK → ${url}`)
    return url
  } catch(e) {
    console.warn(`[UPLOAD] uguu gagal (${e.message.slice(0,80)}), coba tmpfiles...`)
  }
  // 2. Coba tmpfiles.org
  try {
    const url = await uploadImageTmpfiles(buffer, filename)
    console.log(`[UPLOAD] tmpfiles OK → ${url}`)
    return url
  } catch(e) {
    console.warn(`[UPLOAD] tmpfiles gagal (${e.message.slice(0,80)}), coba ImgBB...`)
  }
  // 3. Fallback: ImgBB
  try {
    const url = await uploadImageImgBB(buffer, filename)
    console.log(`[UPLOAD] ImgBB OK → ${url}`)
    return url
  } catch(e) {
    throw new Error(`Semua upload gagal (uguu/tmpfiles/ImgBB): ${e.message.slice(0,100)}`)
  }
}

// ── Helper: kirim gambar ke Whacenter via multipart form-data ──
// Sesuai dokumentasi resmi: field 'file' berisi URL gambar, kirim sebagai multipart
async function sendWAImage(target, isGroup, imgUrl, caption) {
  const deviceId = await fetchDeviceId()  // selalu baca dari CF kv_store
  const form = new FormData()
  form.append('device_id', deviceId)
  form.append('message', caption)
  form.append('file', imgUrl)
  console.log(`[WA] device_id=${deviceId} target=${target} isGroup=${isGroup} imgUrl=${imgUrl}`)
  if (isGroup) {
    form.append('group', target)
    const r = await fetch('https://app.whacenter.com/api/sendGroup', { method: 'POST', body: form })
    const json = await r.json()
    console.log(`[WA] sendGroup response:`, JSON.stringify(json))
    return json
  } else {
    form.append('number', target)
    const r = await fetch('https://app.whacenter.com/api/send', { method: 'POST', body: form })
    const json = await r.json()
    console.log(`[WA] send response:`, JSON.stringify(json))
    return json
  }
}

let browser = null

// Cari chrome binary di PLAYWRIGHT_BROWSERS_PATH secara otomatis
// Playwright headless di Linux pakai chromium_headless_shell, tapi kita bisa
// paksa pakai chromium full dengan explicit executablePath
function findChromeExecutable() {
  // Prioritas 1: env var eksplisit
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  }
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(require('os').homedir(), '.cache', 'ms-playwright')
  try {
    const dirs = fs.readdirSync(browsersPath)
    // Prioritas 2: chromium_headless_shell (jika sudah terinstall)
    const shellDir = dirs.find(d => d.startsWith('chromium_headless_shell'))
    if (shellDir) {
      // chrome-headless-shell-linux64/chrome-headless-shell
      const shellExec = path.join(browsersPath, shellDir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
      if (fs.existsSync(shellExec)) return shellExec
    }
    // Prioritas 3: chromium full (fallback)
    const chromiumDir = dirs.find(d => d.startsWith('chromium-'))
    if (chromiumDir) {
      const chromExec = path.join(browsersPath, chromiumDir, 'chrome-linux64', 'chrome')
      if (fs.existsSync(chromExec)) return chromExec
    }
  } catch(e) { /* ignore */ }
  return null
}

async function getBrowser() {
  // Jika browser masih ada, coba verifikasi masih hidup
  if (browser) {
    try {
      // Cek apakah browser masih connected
      const ctx = await browser.newContext()
      await ctx.close()
      return browser
    } catch(e) {
      console.log('[browser] Stale browser detected, relaunching...')
      try { await browser.close() } catch(_) {}
      browser = null
    }
  }
  // Launch fresh browser — TANPA --single-process (penyebab crash di Render)
  const launchOptions = {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--no-zygote'
    ]
  }
  const execPath = findChromeExecutable()
  if (execPath) {
    console.log(`[browser] Using executable: ${execPath}`)
    launchOptions.executablePath = execPath
  } else {
    console.log('[browser] No executable found, letting playwright decide...')
  }
  browser = await chromium.launch(launchOptions)
  return browser
}

const DEPLOY_VERSION = 'v19-device-id-from-kv-20260918'
// CF_ORIGIN sudah didefinisikan di atas

// ── Anti-duplikat internal Render ───────────────────────────────────────────
// Set tanggal yang sedang diproses agar request ganda (dari CF cron setiap menit)
// tidak trigger screenshot bersamaan. Dihapus saat callback berhasil atau error.
const hopProcessing   = new Set()   // tanggal HOP yang sedang diproses
const neracaProcessing = new Set()  // tanggal Neraca yang sedang diproses

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

  // ── /screenshot-neraca-debug — jalankan screenshot+WA SYNCHRONOUS, return hasil detail
  if (req.method === 'POST' && url.pathname === '/screenshot-neraca-debug') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}')
        const { tanggal, origin, nomor, group, message: waMsg } = parsed
        const baseUrl = origin || 'https://mesin-monitor.pages.dev'
        const tgl = tanggal || new Date().toISOString().split('T')[0]
        const tglFmt = tgl.split('-').reverse().join('.')

        // 1. Fetch HTML dari endpoint render neraca KALSELTENG
        const htmlRes = await fetch(`${baseUrl}/api/neraca-kalselteng-render?tanggal=${tgl}`)
        if (!htmlRes.ok) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, step: 'fetch-html', error: `HTTP ${htmlRes.status}` }))
          return
        }
        const html = await htmlRes.text()
        const dataRows = html.includes('ULD') ? 1 : 0  // sanity check

        // 2. Screenshot
        const br = await getBrowser()
        const ctx = await br.newContext({ viewport:{ width:100, height:100 }, deviceScaleFactor:2 })
        const page = await ctx.newPage()
        await page.setContent(html, { waitUntil:'networkidle' })
        await page.waitForTimeout(300)
        const el  = await page.$('.wrap')
        const box = await el.boundingBox()
        await page.setViewportSize({ width: Math.ceil(box.width+box.x*2), height: Math.ceil(box.height+box.y*2) })
        const shot = await el.screenshot({ type:'png' })
        await ctx.close()
        const imgSize = shot.length

        // 4. Upload gambar ke litterbox.catbox.moe
        let imgUrl = '', uploadResult = null
        try {
          imgUrl = await uploadImage(shot, `DEBUG_NERACA_${tgl}_${Date.now()}.png`)
          uploadResult = { success: true, url: imgUrl }
          console.log(`[UPLOAD-DEBUG] OK → ${imgUrl}`)
        } catch(e) {
          uploadResult = { success: false, error: e.message }
          console.error(`[UPLOAD-DEBUG] FAIL: ${e.message}`)
        }

        // 5. Kirim WA jika ada target
        let waResult = null
        if ((nomor || group) && imgUrl) {
          try {
            const caption = waMsg || `⚡ *NERACA DAYA KALSELTENG — ${tglFmt}*\n_Debug sync test_`
            waResult = await sendWAImage(nomor || group, !nomor, imgUrl, caption)
          } catch(e) { waResult = { error: e.message } }
        }

        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({
          success: true,
          step: 'done',
          data_rows: dataRows,
          screenshot_bytes: imgSize,
          upload: { success: uploadResult?.success, url: imgUrl, error: uploadResult?.error },
          wa: waResult,
          target: nomor ? `nomor:${nomor}` : group ? `group:${group}` : 'none'
        }))
      } catch(e) {
        if (!res.headersSent) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, step: 'exception', error: e.message }))
        }
      }
    })
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

        // Guard duplikat: jika tanggal ini sedang diproses, tolak
        if (hopProcessing.has(tgl)) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ queued: true, reason: `HOP ${tgl} sedang diproses` }))
          return
        }
        hopProcessing.add(tgl)
        console.log(`[screenshot-hop] Mulai proses ${tgl}`)

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

        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ success: true, queued: true }))

        if (nomor || group) {
          ;(async () => {
            let waResult = null
            try {
              const tglFmt = tgl.split('-').reverse().join('.')
              const caption = waMsg || `📊 *HOP BBM KALSELTENG — ${tglFmt}*\nData stok & estimasi BBM per ULD (data H-1)\n_AMC UID KASELTENG_`

              let imgUrl = ''
              try {
                imgUrl = await uploadImage(shot, `HOP_BBM_${tgl}_${Date.now()}.png`)
                console.log(`[UPLOAD-HOP] OK → ${imgUrl}`)
              } catch(e) {
                console.error(`[UPLOAD-HOP] FAIL: ${e.message}`)
              }

              if (imgUrl) {
                waResult = await sendWAImage(nomor || group, !nomor, imgUrl, caption)
                console.log(`[WA-HOP] ${tgl} → ${waResult?.status ? 'OK' : 'FAIL'} ${JSON.stringify(waResult)}`)
              } else {
                console.error(`[WA-HOP] Skip — imgUrl kosong, upload semua gagal`)
                waResult = { error: 'semua upload gagal' }
              }
            } catch(e) {
              console.error(`[WA-HOP] Error kirim: ${e.message}`)
              waResult = { error: e.message }
            }

            if (waResult?.status && callbackUrl) {
              try {
                await fetch(callbackUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tanggal: tgl, status: 'sent' })
                })
                console.log(`[CB-HOP] Callback OK → ${callbackUrl}`)
              } catch(e) { console.error(`[CB-HOP] Callback error: ${e.message}`) }
            }
            hopProcessing.delete(tgl)  // selesai — boleh proses lagi jika retry
          })()
        }

      } catch(e) {
        hopProcessing.delete(tgl)  // error — hapus agar retry bisa masuk
        // Reset browser jika error (stale context / crash)
        if (e.message && (e.message.includes('closed') || e.message.includes('crashed') || e.message.includes('Target'))) {
          console.log('[browser] Resetting stale browser due to error:', e.message.slice(0,80))
          try { if (browser) await browser.close() } catch(_) {}
          browser = null
        }
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
        const parsed = JSON.parse(body || '{}')
        const { tanggal, origin, type } = parsed
        const baseUrl = origin || 'https://mesin-monitor.pages.dev'
        const tgl = tanggal || new Date().toISOString().split('T')[0]
        const tglFmt = tgl.split('-').reverse().join('.')

        // ── Jika type='pbun' → screenshot 6 ULD PBUN dari /api/neraca-pbun-render ──
        if (type === 'pbun') {
          const { nomor, group, message: waMsg, callbackUrl } = parsed
          const guardKey = 'pbun-' + tgl
          if (neracaProcessing.has(guardKey)) {
            res.writeHead(200, {'Content-Type':'application/json'})
            res.end(JSON.stringify({ success: true, queued: true, reason: `PBUN ${tgl} sedang diproses` }))
            return
          }
          neracaProcessing.add(guardKey)
          console.log(`[screenshot-pbun] Mulai proses ${tgl}`)

          const htmlRes = await fetch(`${baseUrl}/api/neraca-pbun-render?tanggal=${tgl}`)
          if (!htmlRes.ok) {
            res.writeHead(200, {'Content-Type':'application/json'})
            res.end(JSON.stringify({ success: false, error: `Gagal fetch HTML PBUN: ${htmlRes.status}` }))
            neracaProcessing.delete(guardKey)
            return
          }
          const html = await htmlRes.text()

          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: true, queued: true }))

          ;(async () => {
            try {
              const br = await getBrowser()
              const ctx = await br.newContext({ viewport:{ width:100, height:100 }, deviceScaleFactor:2 })
              const page = await ctx.newPage()
              await page.setContent(html, { waitUntil:'networkidle' })
              await page.waitForTimeout(200)
              const el  = await page.$('body')
              const box = await el.boundingBox()
              await page.setViewportSize({ width: Math.ceil(box.width + 24), height: Math.ceil(box.height + 24) })
              const shot = await el.screenshot({ type:'png' })
              await ctx.close()

              let imgUrl = ''
              try {
                imgUrl = await uploadImage(shot, `NERACA_PBUN_${tgl}_${Date.now()}.png`)
                console.log(`[UPLOAD-PBUN] OK → ${imgUrl}`)
              } catch(e) { console.error(`[UPLOAD-PBUN] FAIL: ${e.message}`) }

              if (nomor || group) {
                const caption = waMsg || `⚡ *NERACA DAYA UP3 PBUN — ${tglFmt}*\nData beban puncak malam ULD UP3 Pangkalan Bun.\n_AMC UID KASELTENG_`
                let waResult
                if (imgUrl) {
                  waResult = await sendWAImage(nomor || group, !nomor, imgUrl, caption)
                } else {
                  waResult = { error: 'imgUrl kosong, semua upload gagal' }
                }
                console.log(`[WA-PBUN] ${tgl} → ${waResult?.status ? 'OK' : 'FAIL'} ${JSON.stringify(waResult)}`)
                if (waResult?.status && callbackUrl) {
                  await fetch(callbackUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tanggal: tgl, status: 'sent' }) })
                  console.log(`[CB-PBUN] Callback OK → ${callbackUrl}`)
                }
              }
            } catch(e) {
              console.error(`[screenshot-pbun] Error: ${e.message}`)
              if (e.message && (e.message.includes('closed') || e.message.includes('crashed') || e.message.includes('Target'))) {
                try { if (browser) await browser.close() } catch(_) {}
                browser = null
              }
            }
            neracaProcessing.delete(guardKey)
          })()
          return
        }

        // ── Default: screenshot Neraca KALSELTENG 19 ULD ──────────────────────
        // Guard duplikat: jika tanggal ini sedang diproses, tolak
        if (neracaProcessing.has(tgl)) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ queued: true, reason: `Neraca ${tgl} sedang diproses` }))
          return
        }
        neracaProcessing.add(tgl)
        console.log(`[screenshot-neraca] Mulai proses ${tgl}`)

        // Fetch HTML dari endpoint render neraca KALSELTENG
        const htmlRes = await fetch(`${baseUrl}/api/neraca-kalselteng-render?tanggal=${tgl}`)
        if (!htmlRes.ok) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, error: `Gagal fetch HTML neraca: ${htmlRes.status}` }))
          neracaProcessing.delete(tgl)
          return
        }
        const html = await htmlRes.text()

        const br = await getBrowser()
        const ctx = await br.newContext({ viewport:{ width:100, height:100 }, deviceScaleFactor:2 })
        const page = await ctx.newPage()
        await page.setContent(html, { waitUntil:'networkidle' })
        await page.waitForTimeout(300)
        const el  = await page.$('.wrap')
        const box = await el.boundingBox()
        await page.setViewportSize({ width: Math.ceil(box.width+box.x*2), height: Math.ceil(box.height+box.y*2) })
        const shot = await el.screenshot({ type:'png' })
        await ctx.close()

        const { nomor, group, message: waMsg, callbackUrl } = JSON.parse(body || '{}')

        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ success: true, queued: true }))

        if (nomor || group) {
          ;(async () => {
            let waResult = null
            let imgUrl = ''
            try {
              try {
                imgUrl = await uploadImage(shot, `NERACA_${tgl}_${Date.now()}.png`)
                console.log(`[UPLOAD-NERACA] OK → ${imgUrl}`)
              } catch(e) { console.error(`[UPLOAD-NERACA] FAIL: ${e.message}`) }

              const caption = waMsg || `⚡ *NERACA DAYA KALSELTENG — ${tglFmt}*\nData beban puncak malam seluruh ULD\n_AMC UID KASELTENG_`
              if (imgUrl) {
                // Kirim via multipart form-data, field file=URL (sesuai docs resmi Whacenter)
                waResult = await sendWAImage(nomor || group, !nomor, imgUrl, caption)
                console.log(`[WA-NERACA] ${tgl} → ${waResult?.status ? 'OK' : 'FAIL'} ${JSON.stringify(waResult)}`)
              } else {
                console.error(`[WA-NERACA] Skip — imgUrl kosong, semua upload gagal`)
                waResult = { error: 'semua upload gagal' }
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
            neracaProcessing.delete(tgl)  // selesai — boleh proses lagi jika retry
          })()
        }

      } catch(e) {
        neracaProcessing.delete(tgl)  // error — hapus agar retry bisa masuk
        // Reset browser jika error (stale context / crash)
        if (e.message && (e.message.includes('closed') || e.message.includes('crashed') || e.message.includes('Target'))) {
          console.log('[browser] Resetting stale browser (neraca):', e.message.slice(0,80))
          try { if (browser) await browser.close() } catch(_) {}
          browser = null
        }
        if (!res.headersSent) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, error: e.message }))
        }
      }
    })
    return
  }

  // ── /screenshot-pbun — screenshot 6 ULD UP3 PBUN ────────────────────────
  if (req.method === 'POST' && url.pathname === '/screenshot-pbun') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const { tanggal, origin, nomor, group, message: waMsg, callbackUrl } = JSON.parse(body || '{}')
        const baseUrl = origin || 'https://mesin-monitor.pages.dev'
        const tgl = tanggal || new Date().toISOString().split('T')[0]
        const tglFmt = tgl.split('-').reverse().join('.')

        // Guard duplikat
        if (neracaProcessing.has('pbun-' + tgl)) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: true, queued: true, reason: `PBUN ${tgl} sedang diproses` }))
          return
        }
        neracaProcessing.add('pbun-' + tgl)
        console.log(`[screenshot-pbun] Mulai proses ${tgl}`)

        // Fetch HTML dari endpoint render PBUN
        const htmlRes = await fetch(`${baseUrl}/api/neraca-pbun-render?tanggal=${tgl}`)
        if (!htmlRes.ok) {
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ success: false, error: `Gagal fetch HTML PBUN: ${htmlRes.status}` }))
          neracaProcessing.delete('pbun-' + tgl)
          return
        }
        const html = await htmlRes.text()

        // Screenshot dengan Playwright
        const br = await getBrowser()
        const ctx = await br.newContext({ viewport:{ width:100, height:100 }, deviceScaleFactor:2 })
        const page = await ctx.newPage()
        await page.setContent(html, { waitUntil:'networkidle' })
        await page.waitForTimeout(200)
        const el  = await page.$('body')
        const box = await el.boundingBox()
        await page.setViewportSize({ width: Math.ceil(box.width + 24), height: Math.ceil(box.height + 24) })
        const shot = await el.screenshot({ type:'png' })
        await ctx.close()

        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ success: true, queued: true }))

        // Upload + kirim WA async
        ;(async () => {
          let imgUrl = ''
          try {
            imgUrl = await uploadImage(shot, `NERACA_PBUN_${tgl}_${Date.now()}.png`)
            console.log(`[UPLOAD-PBUN] OK → ${imgUrl}`)
          } catch(e) { console.error(`[UPLOAD-PBUN] FAIL: ${e.message}`) }

          if (imgUrl && (nomor || group)) {
            try {
              const caption = waMsg || `⚡ *NERACA DAYA UP3 PBUN — ${tglFmt}*\nData beban puncak malam ULD UP3 Pangkalan Bun.\n_AMC UID KASELTENG_`
              const waResult = await sendWAImage(nomor || group, !nomor, imgUrl, caption)
              console.log(`[WA-PBUN] ${tgl} → ${waResult?.status ? 'OK' : 'FAIL'} ${JSON.stringify(waResult)}`)

              if (waResult?.status && callbackUrl) {
                await fetch(callbackUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tanggal: tgl, status: 'sent' }) })
                console.log(`[CB-PBUN] Callback OK → ${callbackUrl}`)
              }
            } catch(e) { console.error(`[WA-PBUN] Error: ${e.message}`) }
          }
          neracaProcessing.delete('pbun-' + tgl)
        })()

      } catch(e) {
        neracaProcessing.delete('pbun-' + tgl)
        if (e.message && (e.message.includes('closed') || e.message.includes('crashed') || e.message.includes('Target'))) {
          console.log('[browser] Resetting stale browser (pbun):', e.message.slice(0,80))
          try { if (browser) await browser.close() } catch(_) {}
          browser = null
        }
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

  // Chromium diinstall saat build (render.yaml buildCommand)
  // Cek status saat startup untuk logging saja
  const chromiumStatus = getChromiumStatus()
  console.log(`[chromium] status: ${JSON.stringify(chromiumStatus)}`)
  if (chromiumStatus.installed) {
    console.log(`[chromium] Ready ✓ (${chromiumStatus.dir})`)
  } else {
    console.error(`[chromium] WARNING: not ready — ${chromiumStatus.reason}`)
    console.error(`[chromium] Pastikan buildCommand di Render: npm install && npx playwright install --only-shell chromium`)
  }

  // Self keep-alive setiap 14 menit (Render free spin-down = 15 menit idle)
  setInterval(async () => {
    try {
      await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(5000) })
    } catch(e) { /* ignore */ }
  }, 14 * 60 * 1000)

  // ── POLL HOP-CHECK setiap 60 detik ──────────────────────────────────────
  // Render sendiri yang cek ke CF apakah ada HOP BBM yang perlu dikirim
  // Ini menggantikan ketergantungan pada CF cron scheduled (tidak reliable)
  let hopPollRunning = false
  setInterval(async () => {
    if (hopPollRunning) return  // skip jika masih proses sebelumnya
    hopPollRunning = true
    try {
      const checkRes = await fetch(`${CF_ORIGIN}/api/hop-check`, {
        signal: AbortSignal.timeout(15000)
      })
      const checkJson = await checkRes.json()

      if (!checkJson.perlu_kirim) {
        // Tidak ada yang perlu dikirim, skip
        hopPollRunning = false
        return
      }

      const { tanggal, origin, callbackUrl } = checkJson
      const tglFmt = tanggal.split('-').reverse().join('.')
      console.log(`[poll-hop] Perlu kirim HOP BBM ${tglFmt}, mulai screenshot...`)

      // Ambil data stok dari CF
      const apiRes = await fetch(`${origin}/api/data-stok?tanggal=${tanggal}`, {
        signal: AbortSignal.timeout(15000)
      })
      const apiJson = await apiRes.json()
      if (!apiJson.success || !apiJson.data?.length) {
        console.error(`[poll-hop] data-stok kosong untuk ${tanggal}`)
        hopPollRunning = false
        return
      }

      // Ambil penerima dari CF (wa-penerima-hop)
      let penerima = [{ type: 'grup', target: 'AMC UID KASELTENG' }]
      try {
        const penRes = await fetch(`${origin}/api/kv-get?key=wa-penerima-hop`, {
          signal: AbortSignal.timeout(5000)
        })
        const penJson = await penRes.json()
        if (penJson.value) penerima = JSON.parse(penJson.value)
      } catch(_) {}

      // Ambil data HOP info
      let hopMap = {}
      try {
        const hopRes = await fetch(`${origin}/api/hop-info`, { signal: AbortSignal.timeout(5000) })
        const hopJson = await hopRes.json()
        if (hopJson.success && hopJson.data) hopMap = hopJson.data
      } catch(e) {}

      // Buat HTML + screenshot (reuse logika dari /screenshot-hop)
      const rows = apiJson.data
      const BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']
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

      // Screenshot
      const br = await getBrowser()
      const ctx2 = await br.newContext({ viewport: { width: 100, height: 100 }, deviceScaleFactor: 2 })
      const page = await ctx2.newPage()
      await page.setContent(html, { waitUntil: 'networkidle' })
      await page.waitForTimeout(200)
      const el  = await page.$('.wrap')
      const box = await el.boundingBox()
      await page.setViewportSize({ width: Math.ceil(box.width+box.x*2), height: Math.ceil(box.height+box.y*2) })
      const shot = await el.screenshot({ type: 'png' })
      await ctx2.close()
      console.log(`[poll-hop] Screenshot OK untuk ${tglFmt}`)

      // Upload ke litterbox
      let imgUrl = ''
      try {
        imgUrl = await uploadImage(shot, `HOP_BBM_${tanggal}_${Date.now()}.png`)
        console.log(`[poll-hop] Upload OK → ${imgUrl}`)
      } catch(e) {
        console.error(`[poll-hop] Upload GAGAL: ${e.message}`)
      }

      if (!imgUrl) {
        hopPollRunning = false
        return
      }

      // Kirim ke semua penerima
          const caption = `📊 *HOP BBM KALSELTENG — ${tglFmt}*\nData stok & estimasi BBM per ULD (data H-1)\n_AMC UID KASELTENG_`
      let adaBerhasil = false
      for (const p of penerima) {
        try {
          const waJson = await sendWAImage(p.target, p.type !== 'nomor', imgUrl, caption)
          if (waJson.status) {
            adaBerhasil = true
            console.log(`[poll-hop] WA OK → ${p.type} ${p.target}`)
          } else {
            console.error(`[poll-hop] WA FAIL → ${p.type} ${p.target}: ${JSON.stringify(waJson)}`)
          }
        } catch(e) {
          console.error(`[poll-hop] WA error → ${p.type} ${p.target}: ${e.message}`)
        }
      }

      // Callback ke CF jika berhasil
      if (adaBerhasil && callbackUrl) {
        try {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tanggal, status: 'sent' })
          })
          console.log(`[poll-hop] Callback OK → ${callbackUrl}`)
        } catch(e) { console.error(`[poll-hop] Callback error: ${e.message}`) }
      }

    } catch(e) {
      console.error(`[poll-hop] Error: ${e.message}`)
    }
    hopPollRunning = false
  }, 60 * 1000)  // setiap 60 detik
})
