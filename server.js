// ===== เซิร์ฟเวอร์ตรวจโค้ดรับแต้ม (โปรเจกต์ Render แยกใหม่) =====
// หน้าที่: รับคำขอใช้โค้ดจากหน้าเว็บ -> ตรวจสิทธิ์ผู้ใช้ -> ถาม Supabase ว่าโค้ดมีจริง/หมดอายุ/เต็มโควต้า/ใช้ไปแล้วไหม
//          -> ถ้าผ่านก็ตัดโควต้าและบวกแต้ม -> ตอบผลกลับไป

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGIN } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ขาดค่า SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY ใน Environment');
  process.exit(1);
}

// client สิทธิ์สูง (service role) ใช้ฝั่งเซิร์ฟเวอร์เท่านั้น
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = express();

app.use(cors({
  origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map((s) => s.trim()) : '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10kb' }));

// เช็กว่าเซิร์ฟเวอร์ตื่นอยู่ (เปิดลิงก์หลักในเบราว์เซอร์จะเห็นข้อความนี้)
app.get('/', (req, res) => res.json({ ok: true, service: 'redeem-server' }));

// ---------------------------------------------------------------------------
// ⚠️ จุดที่ต้องเชื่อมกับระบบแต้มเดิมของคุณ (ยังไม่ได้เชื่อม)
// ต้องบวกแต้มให้ตรงกับที่หน้าเว็บอ่านผ่าน /api/my-points คือ
//   week_points (แต้มรายสัปดาห์ หมดอายุ 7 วัน), total_points (แต้มสะสม), week_expires_at
// ต้องรู้ชื่อตารางและคอลัมน์ที่เก็บค่าพวกนี้ใน Supabase ก่อน จึงจะเขียนส่วนนี้ได้ถูกต้อง
// ระหว่างที่ยังไม่เชื่อม ฟังก์ชันนี้จะโยน error และโค้ดที่ใช้ไปจะถูกย้อนคืนอัตโนมัติ
// ---------------------------------------------------------------------------
async function addPointsForUser(userId, amount) {
  throw new Error('ยังไม่ได้เชื่อมระบบบวกแต้ม');
}

// กันเดาโค้ด: ลองได้ 5 ครั้งต่อนาทีต่อคน
const attempts = new Map(); // userId -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
}, 5 * 60 * 1000).unref();

app.post('/api/redeem-code', async (req, res) => {
  try {
    // 1) ตรวจว่าล็อกอินจริง (ใช้ token ของ Supabase ที่หน้าเว็บส่งมา)
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });

    const { data: u, error: uErr } = await supabaseAdmin.auth.getUser(token);
    if (uErr || !u || !u.user) {
      return res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    }
    const userId = u.user.id;

    // 2) จำกัดจำนวนครั้งที่ลอง
    const now = Date.now();
    const a = attempts.get(userId);
    if (a && a.resetAt > now && a.count >= 5) {
      return res.status(429).json({ error: 'ลองบ่อยเกินไป รอสักครู่แล้วลองใหม่' });
    }
    if (!a || a.resetAt <= now) attempts.set(userId, { count: 1, resetAt: now + 60000 });
    else a.count++;

    // 3) ตรวจรูปแบบโค้ด
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      return res.status(400).json({ error: 'รูปแบบโค้ดไม่ถูกต้อง' });
    }

    // 4) ถาม Supabase: โค้ดมีจริงไหม / หมดอายุไหม / เต็มโควต้าไหม / คนนี้เคยใช้ไหม แล้วตัดโควต้า
    //    (ทำในฐานข้อมูลแบบล็อกแถว กันหลายคนกดพร้อมกันแล้วเกินโควต้า)
    const { data, error } = await supabaseAdmin.rpc('redeem_code', { p_user: userId, p_code: code });
    if (error) throw error;
    if (!data || !data.ok) {
      return res.status(400).json({ error: (data && data.error) || 'ใช้โค้ดไม่สำเร็จ' });
    }

    // 5) บวกแต้ม ถ้าพลาดให้ย้อนโควต้าคืน
    try {
      await addPointsForUser(userId, data.points);
    } catch (e) {
      await supabaseAdmin.rpc('redeem_undo', { p_user: userId, p_code: code });
      throw e;
    }

    res.json({
      success: true,
      points: data.points,
      remaining: data.remaining,
      message: 'รับแต้มสำเร็จ +' + data.points + ' แต้ม ✅'
    });
  } catch (err) {
    console.error('redeem-code error:', err);
    res.status(500).json({ error: 'เซิร์ฟเวอร์ผิดพลาด ลองใหม่อีกครั้ง' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'ไม่พบเส้นทางนี้' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('redeem-server listening on ' + PORT));
                                                                       
