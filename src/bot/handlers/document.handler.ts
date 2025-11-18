import { MyContext } from '../types/types';
import { CodeModel } from '../../db/models/codes.model';
import { WinnerModel } from '../../db/models/winners.model';
import { GiftModel } from '../../db/models/gifts.model';
import XLSX from 'xlsx';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { ADMIN_TG_ID, BOT_TOKEN } from '../config';
import bot from '../core/bot';
import { getAdminSession } from '../actions/admin.action';
import { Types } from 'mongoose';

const normalize = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const hyphenize = (s: string) =>
  s.includes('-') ? s : s.length > 6 ? s.slice(0, 6) + '-' + s.slice(6) : s;

async function extractCodes(filePath: string): Promise<string[]> {
  const codes = new Set<string>();
  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    for (const row of rows) {
      for (const cell of row) {
        const val = cell?.toString().trim();
        if (!val || val.length < 6) continue;
        if (/^(kod|code|id|№|raqam|#)/i.test(val)) continue;
        const n = normalize(val);
        if (n.length >= 8) codes.add(n);
      }
    }
  } catch (e) {
    console.error("Excel o'qishda xato:", e);
  }
  return Array.from(codes);
}

async function saveCodes(codes: string[]) {
  const existing = await CodeModel.find({ deletedAt: null }).select('value').lean();
  const set = new Set(existing.map(c => normalize(c.value)));

  const ops: any[] = [];
  let maxId = 0;
  const lastCode = await CodeModel.findOne({ deletedAt: null }).sort({ id: -1 }).lean();
  if (lastCode?.id) maxId = lastCode.id;

  for (const code of codes) {
    const clean = normalize(code);
    if (set.has(clean)) continue;

    const pretty = clean.length >= 10 ? clean.slice(0, 6) + '-' + clean.slice(6) : clean;
    maxId++;

    ops.push({
      insertOne: {
        document: {
          id: maxId,
          value: pretty,
          isUsed: false,
          version: 2,
          giftId: null,
          deletedAt: null,
        }
      }
    });
    set.add(clean);
  }

  if (ops.length > 0) {
    await CodeModel.bulkWrite(ops, { ordered: false }).catch(console.error);
  }

  return { success: ops.length, duplicates: codes.length - ops.length };
}

async function saveWinners(codes: string[], tier: 'premium' | 'standard' | 'economy' | 'symbolic') {
  const existing = await WinnerModel.find({ deletedAt: null }).select('value').lean();
  const set = new Set(existing.map(c => normalize(c.value)));

  const ops: any[] = [];
  let maxId = 0;
  const lastWinner = await WinnerModel.findOne({ deletedAt: null }).sort({ id: -1 }).lean();
  if (lastWinner?.id) maxId = lastWinner.id;

  // Gift modeldan tier bo'yicha giftId ni topish yoki yaratish
  let gift = await GiftModel.findOne({ type: tier, deletedAt: null }).lean();
  
  if (!gift) {
    // Gift topilmasa, yangi gift yaratamiz (placeholder rasm URL bilan)
    const giftCount = await GiftModel.countDocuments();
    const tierNames: Record<string, string> = {
      premium: 'Premium sovg\'a',
      standard: 'Standard sovg\'a',
      economy: 'Economy sovg\'a',
      symbolic: 'Symbolic sovg\'a',
    };

    // Placeholder rasm URL (keyinroq admin rasm yuklaydi)
    const placeholderImage = `/files/gift-images/placeholder_${tier}.jpg`;

    const newGift = await GiftModel.create({
      id: giftCount + 1,
      name: tierNames[tier] || `${tier} sovg'a`,
      type: tier,
      image: placeholderImage,
      images: {
        uz: placeholderImage,
        ru: placeholderImage,
      },
      totalCount: 0,
      usedCount: 0,
      deletedAt: null,
    });
    
    gift = newGift.toObject();
    console.log(`YANGI GIFT YARATILDI: ${tier}`, gift._id);
  }
  
  const giftId = gift._id;

  for (const code of codes) {
    const clean = normalize(code);
    if (set.has(clean)) continue;

    const pretty = clean.length >= 10 ? clean.slice(0, 6) + '-' + clean.slice(6) : clean;
    maxId++;

    ops.push({
      insertOne: {
        document: {
          id: maxId,
          value: pretty,
          tier,
          giftId,
          isUsed: false,
          deletedAt: null,
        }
      }
    });
    set.add(clean);
  }

  if (ops.length > 0) {
    await WinnerModel.bulkWrite(ops, { ordered: false }).catch(console.error);
  }

  return { success: ops.length, duplicates: codes.length - ops.length };
}

// ASOSIY HANDLER
export const handleDocument = async (ctx: MyContext) => {
  console.log("DOCUMENT HANDLER ISHGA TUSHDI! User:", ctx.from?.id, "Admin ID:", ADMIN_TG_ID);

  if (Number(ctx.from?.id) !== Number(ADMIN_TG_ID)) {
    console.log("Admin emas, e'tiborsiz qoldirildi");
    return;
  }

  const doc = ctx.message?.document;
  if (!doc?.file_id) return ctx.reply("Fayl ID topilmadi");

  const ext = (doc.file_name || "").split(".").pop()?.toLowerCase();
  if (!["xlsx", "xls", "csv", "txt"].includes(ext || "")) {
    return ctx.reply("Faqat Excel/CSV/TXT fayllar!");
  }

  const session = getAdminSession(ctx.from!.id);
  
  // Agar rejim o'rnatilmagan bo'lsa, default kodlar rejimi
  if (!session.mode || (session.mode !== 'upload_winners' && session.mode !== 'upload_codes')) {
    session.mode = 'upload_codes';
  }
  
  const isWinnerMode = session.mode === 'upload_winners';
  const winnerTier = session.winnerTier;

  // Agar g'olib kodlar rejimi bo'lsa va kategoriya tanlanmagan bo'lsa
  if (isWinnerMode && !winnerTier) {
    return ctx.reply(
      '❌ Kategoriya tanlanmagan!\n\nAvval kategoriyani tanlang: /admin → G\'olib kodlarni kiritish'
    );
  }

  const tierNames: Record<string, string> = {
    premium: '💎 Premium',
    standard: '⭐ Standard',
    economy: '💰 Economy',
    symbolic: '🎁 Symbolic',
  };

  try {
    await ctx.reply(
      isWinnerMode 
        ? `Salom admin! Fayl qabul qilindi, ${tierNames[winnerTier!]} kategoriyasidagi g'olib kodlar yuklanmoqda...` 
        : "Salom admin! Fayl qabul qilindi, kodlar yuklanmoqda..."
    );

    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Fayl yuklanmadi");

    const buffer = Buffer.from(await res.arrayBuffer());
    const tempPath = join(process.cwd(), `temp_${Date.now()}_${doc.file_name}`);
    await writeFile(tempPath, buffer);

    const codes = await extractCodes(tempPath);
    await unlink(tempPath).catch(() => {});

    if (codes.length === 0) {
      return ctx.reply("Faylda kod topilmadi 😢");
    }

    await ctx.reply(`${codes.length} ta kod topildi, bazaga yozilmoqda...`);

    let result;
    let total;

    if (isWinnerMode) {
      if (!winnerTier) {
        return ctx.reply('❌ Kategoriya tanlanmagan!');
      }
      
      result = await saveWinners(codes, winnerTier);
      const tierTotal = await WinnerModel.countDocuments({ tier: winnerTier, deletedAt: null });
      const total = await WinnerModel.countDocuments({ deletedAt: null });
      
      await ctx.reply(`
✅ <b>${tierNames[winnerTier]} kategoriyasidagi g'olib kodlar yuklandi!</b>

Yuklangan: <b>${result.success}</b>
Duplikat: <b>${result.duplicates}</b>
${tierNames[winnerTier]} kategoriyasida: <b>${tierTotal}</b> ta kod
Jami bazada: <b>${total}</b> ta g'olib kod

Hammasi tayyor admin! 🚀
      `, { parse_mode: "HTML" });
    } else {
      result = await saveCodes(codes);
      total = await CodeModel.countDocuments({ deletedAt: null });
      
      await ctx.reply(`
✅ <b>Kodlar yuklandi!</b>

Yuklangan: <b>${result.success}</b>
Duplikat: <b>${result.duplicates}</b>
Jami bazada: <b>${total}</b> ta kod

Hammasi tayyor admin! 🚀
      `, { parse_mode: "HTML" });
    }

    // Session state ni tozalash
    session.mode = null;
    session.winnerTier = null;

  } catch (err: any) {
    console.error("ADMIN EXCEL XATOSI:", err);
    await ctx.reply(`Xato: ${err.message}`);
    session.mode = null;
    session.winnerTier = null;
  }
};

// Document handler - message handler dan oldin ishlashi kerak
bot.on('message:document', async (ctx, next) => {
  if (Number(ctx.from?.id) === Number(ADMIN_TG_ID)) {
    console.log("ADMIN DOCUMENT QABUL QILINDI – handler ishlayapti!");
    await handleDocument(ctx);
    return; // boshqa handlerlarga o'tmasin
  }
  return next();
});

console.log("Document handler bot.use() bilan ulandi – 100% ishlaydi!");
