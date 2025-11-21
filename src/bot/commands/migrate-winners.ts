import bot from '../core/bot';
import { isAdmin } from '../config';
import { WinnerModel } from '../../db/models/winners.model';

// Bu komanda endi kerak emas - g'olib kodlar allaqachon bazada saqlanadi
// Agar eski kodlarni tozalash kerak bo'lsa, bu komandani ishlatish mumkin
bot.command('migrate_winners', async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply('❌ Siz admin emassiz.');
  }

  try {
    const winnerCount = await WinnerModel.countDocuments({ deletedAt: null });
    
    await ctx.reply(`
ℹ️ <b>G'olib kodlar migratsiyasi</b>

Bu komanda endi kerak emas. G'olib kodlar allaqachon bazada saqlanadi.

Jami bazada: <b>${winnerCount}</b> ta g'olib kod

G'olib kodlarni yuklash uchun /admin → G'olib kodlarni kiritish
    `, { parse_mode: 'HTML' });

  } catch (error: any) {
    console.error("MIGRATION XATOSI:", error);
    await ctx.reply(`❌ Xato: ${error.message}`);
  }
});

