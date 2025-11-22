import { MyContext } from '../types/types';
import { CodeModel } from '../../db/models/codes.model';
import { WinnerModel } from '../../db/models/winners.model';
import { GiftModel } from '../../db/models/gifts.model';
import XLSX from 'xlsx';
import { unlink } from 'fs/promises';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { isAdmin, BOT_TOKEN } from '../config';
import bot from '../core/bot';
import { getAdminSession } from '../actions/admin.action';
import { Types } from 'mongoose';

const normalize = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const hyphenize = (s: string) => s.includes('-') ? s : s.length > 6 ? s.slice(0, 6) + '-' + s.slice(6) : s;

const BATCH_SIZE = 5000;

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

async function bulkInsert(model: any, codes: string[], giftId?: Types.ObjectId, tier?: string, month?: string | null) {
  const existing = await model.find({ deletedAt: null }).select('value').lean();
  const set = new Set(existing.map((c: any) => normalize(c.value)));

  let maxId = 0;
  const last = await model.findOne({ deletedAt: null }).sort({ id: -1 }).lean();
  if (last?.id) maxId = last.id;

  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batchCodes = codes.slice(i, i + BATCH_SIZE).filter(c => !set.has(normalize(c)));
    const ops = batchCodes.map(c => {
      const clean = normalize(c);
      set.add(clean);
      maxId++;
      return {
        insertOne: {
          document: {
            id: maxId,
            value: clean.length >= 10 ? clean.slice(0, 6) + '-' + clean.slice(6) : clean,
            ...(tier ? { tier, giftId } : { isUsed: false, version: 2, giftId: null }),
            ...(month ? { month } : { month: null }),
            deletedAt: null,
          }
        }
      };
    });
    if (ops.length > 0) await model.bulkWrite(ops, { ordered: false }).catch(console.error);
    console.log(`Batch ${i / BATCH_SIZE + 1} yozildi`);
  }

  return {
    success: set.size - existing.length,
    duplicates: codes.length - (set.size - existing.length),
  };
}

async function saveWinners(codes: string[], tier: 'premium' | 'standard' | 'economy' | 'symbolic', month?: string | null) {
  let gift = await GiftModel.findOne({ type: tier, deletedAt: null }).lean();
  if (!gift) {
    const giftCount = await GiftModel.countDocuments();
    const tierNames: Record<string, string> = {
      premium: 'Premium sovg\'a',
      standard: 'Standard sovg\'a',
      economy: 'Economy sovg\'a',
      symbolic: 'Symbolic sovg\'a',
    };
    const placeholderImage = `/files/gift-images/placeholder_${tier}.jpg`;
    const newGift = await GiftModel.create({
      id: giftCount + 1,
      name: tierNames[tier],
      type: tier,
      image: placeholderImage,
      images: { uz: placeholderImage, ru: placeholderImage },
      totalCount: 0,
      usedCount: 0,
      deletedAt: null,
    });
    gift = newGift.toObject();
    console.log(`Yangi gift yaratildi: ${tier}`);
  }

  return bulkInsert(WinnerModel, codes, gift._id, tier, month);
}

async function saveCodes(codes: string[], month?: string | null) {
  return bulkInsert(CodeModel, codes, undefined, undefined, month);
}

// ASOSIY HANDLER
export const handleDocument = async (ctx: MyContext) => {
  if (!isAdmin(ctx.from?.id)) return;

  const doc = ctx.message?.document;
  if (!doc?.file_id) return ctx.reply("Fayl ID topilmadi");
  const ext = (doc.file_name || "").split(".").pop()?.toLowerCase();
  if (!["xlsx", "xls", "csv", "txt"].includes(ext || "")) return ctx.reply("Faqat Excel/CSV/TXT fayllar!");

  const session = getAdminSession(ctx.from!.id);
  if (!session.mode || !['upload_winners','upload_codes'].includes(session.mode)) session.mode = 'upload_codes';
  const isWinnerMode = session.mode === 'upload_winners';
  const winnerTier = session.winnerTier;
  const selectedMonth = session.selectedMonth;

  if (isWinnerMode && !winnerTier) return ctx.reply('❌ Kategoriya tanlanmagan!');
  if (!selectedMonth) return ctx.reply('❌ Oy tanlanmagan!');

  try {
    await ctx.reply(isWinnerMode ? `Fayl qabul qilindi, ${winnerTier} kategoriyasidagi g'olib kodlar yuklanmoqda...` : "Fayl qabul qilindi, kodlar yuklanmoqda...");

    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Fayl yuklanmadi");
    const buffer = Buffer.from(await res.arrayBuffer());
    const tempPath = join(process.cwd(), `temp_${Date.now()}_${doc.file_name}`);
    await writeFile(tempPath, buffer);

    const codes = await extractCodes(tempPath);
    await unlink(tempPath).catch(() => {});
    if (!codes.length) return ctx.reply("Faylda kod topilmadi 😢");

    await ctx.reply(`${codes.length} ta kod topildi, bazaga yozilmoqda...`);

    let result;
    if (isWinnerMode) {
      result = await saveWinners(codes, winnerTier!, selectedMonth);
    } else {
      result = await saveCodes(codes, selectedMonth);
    }

    const total = isWinnerMode
      ? await WinnerModel.countDocuments({ deletedAt: null })
      : await CodeModel.countDocuments({ deletedAt: null });

    await ctx.reply(`
✅ Kodlar yuklandi!
Yuklangan: <b>${result.success}</b>
Duplikat: <b>${result.duplicates}</b>
Jami bazada: <b>${total}</b>
`, { parse_mode: "HTML" });

    session.mode = null;
    session.winnerTier = null;
    session.selectedMonth = null;
  } catch (err: any) {
    console.error("ADMIN EXCEL XATOSI:", err);
    await ctx.reply(`Xato: ${err.message}`);
    session.mode = null;
    session.winnerTier = null;
    session.selectedMonth = null;
  }
};

bot.on('message:document', async (ctx, next) => {
  if (isAdmin(ctx.from?.id)) {
    await handleDocument(ctx);
    return;
  }
  return next();
});

console.log("Document handler bot.use() bilan ulandi – 100% ishlaydi!");
