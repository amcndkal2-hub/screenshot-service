const http = require('http')
const { chromium } = require('playwright')

const WHACENTER_DEVICE_ID = '550fd04ee9fc7c4b4e057d0bce6270f3'

let browser = null

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] })
  }
  return browser
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3001')

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'})
    res.end(JSON.stringify({ ok: true }))
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

          // p = padding kecil, teks kecil — supaya 20 kolom muat di ~1600px
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

        // deviceScaleFactor: 2 → render 2x lebih detail, output tetap ukuran wajar tapi sharp
        const br = await getBrowser()
        const ctx = await br.newContext({
          viewport: { width: 100, height: 100 },
          deviceScaleFactor: 2
        })
        const page = await ctx.newPage()
        await page.setContent(html, { waitUntil: 'networkidle' })
        await page.waitForTimeout(200)

        // Ukur konten nyata, set viewport tepat
        const el  = await page.$('.wrap')
        const box = await el.boundingBox()
        await page.setViewportSize({
          width:  Math.ceil(box.width  + box.x * 2),
          height: Math.ceil(box.height + box.y * 2)
        })

        const shot = await el.screenshot({ type: 'png' })
        await ctx.close()

        const { nomor, group, message: waMsg, callbackUrl } = JSON.parse(body || '{}')

        // Langsung response ke CF Worker — jangan buat CF timeout
        // CF Worker sudah fire-and-forget, screenshot service kirim WA + callback sendiri
        const b64 = shot.toString('base64')
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ success: true, queued: true }))

        // Kirim WA + callback di background (setelah response dikirim)
        if (nomor || group) {
          ;(async () => {
            let waResult = null
            let imgUrl = ''
            try {
              const tglFmt = tgl.split('-').reverse().join('.')
              const caption = waMsg || `📊 *HOP BBM KALSELTENG — ${tglFmt}*\nData stok & estimasi BBM per ULD (data H-1)\n_AMC UID KASELTENG_`

              // STEP 1: Upload ke imgbb → dapat public URL
              // Nama unik dengan timestamp agar imgbb selalu beri URL baru (hindari dedup)
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

              // STEP 2: Kirim ke Whacenter via JSON body {file: imgbbUrl}
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

            // Callback ke CF Worker untuk update KV hop-last-sent-date
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
        // Hanya kirim response kalau belum dikirim
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

        // Ambil data neraca daya
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

        // Hitung total
        let totDmTerpasang=0, totDmPasok=0, totBpSiang=0, totBpMalam=0
        let totOps=0, totStby=0, totPem=0, totGng=0, totRsk=0
        rows.forEach(d => {
          totDmTerpasang += d.dm_terpasang||0
          totDmPasok     += d.dm_pasok||0
          totBpSiang     += d.beban_puncak_siang||0
          totBpMalam     += d.beban_puncak_malam||0
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

          // Status warna berdasarkan N-1
          const n1 = (d.beban_puncak_malam||0) - (d.dm_pasok||0)
          const statusColor = n1 < -50 ? '#22c55e' : n1 < 0 ? '#eab308' : '#ef4444'
          const statusLabel = n1 < -50 ? 'NORMAL' : n1 < 0 ? 'SIAGA' : 'KRITIS'

          rows_html += `<tr style="background:${rowBg};">
            <td style="${p}text-align:center;">${i+1}</td>
            <td style="${p}font-weight:600;white-space:nowrap;">${d.nama_unit}</td>
            <td style="${p}text-align:right;">${fmtN0(d.dm_terpasang)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.dm_pasok)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.beban_puncak_siang)}</td>
            <td style="${p}text-align:right;font-weight:600;">${fmtNum(d.beban_puncak_malam)}</td>
            <td style="${p}text-align:right;">${fmtNum(d.max_dm)}</td>
            <td style="${p}text-align:center;">${d.jumlah_operasi||0}</td>
            <td style="${p}text-align:center;">${d.jumlah_standby||0}</td>
            <td style="${p}text-align:center;">${d.jumlah_pemeliharaan||0}</td>
            <td style="${p}text-align:center;">${d.jumlah_gangguan||0}</td>
            <td style="${p}text-align:center;">${d.jumlah_rusak||0}</td>
            <td style="${p}text-align:center;font-weight:700;color:${statusColor};">${statusLabel}</td>
          </tr>`
        })

        // Row total
        rows_html += `<tr style="background:#1e3a5f;color:#fff;font-weight:700;">
          <td colspan="2" style="padding:5px 7px;text-align:center;">TOTAL</td>
          <td style="padding:5px 7px;text-align:right;">${totDmTerpasang.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">${totDmPasok.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">${totBpSiang.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">${totBpMalam.toLocaleString('id-ID')}</td>
          <td style="padding:5px 7px;text-align:right;">—</td>
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
      <th style="${th}">DM<br>TERPASANG</th>
      <th style="${th}">DM<br>PASOK</th>
      <th style="${th}">BP<br>SIANG</th>
      <th style="${th}">BP<br>MALAM</th>
      <th style="${th}">MAX<br>DM</th>
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

        // Screenshot via Playwright
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

        // Upload ke imgbb → dapat public URL
        const b64 = shot.toString('base64')
        let imgUrl = ''
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

        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ success: !!imgUrl, url: imgUrl, error: imgUrl ? undefined : 'imgbb upload gagal' }))

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

  // Self keep-alive: ping diri sendiri setiap 30 detik
  // Mencegah sandbox Novita sleep — lebih andal dari CF cron karena dari dalam sandbox
  setInterval(async () => {
    try {
      await fetch('http://localhost:3001/health', { signal: AbortSignal.timeout(5000) })
    } catch(e) { /* ignore */ }
  }, 30 * 1000)
})
