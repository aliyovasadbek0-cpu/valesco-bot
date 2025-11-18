import bot from '../core/bot';
import { CallbackActions } from '../types/enum';
import { isAdmin } from '../config';
import { CodeModel } from '../../db/models/codes.model';
import { WinnerModel } from '../../db/models/winners.model';
import { GiftModel } from '../../db/models/gifts.model';
import { InlineKeyboard } from 'grammy';

// Admin session state
const adminSessions = new Map<number, {
  mode: 'upload_codes' | 'upload_winners' | 'upload_images' | null;
  imageType: 'premium' | 'standard' | 'economy' | 'symbolic' | null;
  winnerTier: 'premium' | 'standard' | 'economy' | 'symbolic' | null;
}>();

function getAdminSession(userId: number) {
  if (!adminSessions.has(userId)) {
    adminSessions.set(userId, { mode: null, imageType: null, winnerTier: null });
  }
  return adminSessions.get(userId)!;
}

// Admin menu keyboard
function getAdminKeyboard() {
  return new InlineKeyboard()
    .text('📥 Kodlar kiritish', CallbackActions.ADMIN_UPLOAD_CODES)
    .row()
    .text('🎁 G\'olib kodlarni kiritish', CallbackActions.ADMIN_UPLOAD_WINNERS)
    .row()
    .text('🗑️ Kodlarni tozalash', CallbackActions.ADMIN_CLEAR_CODES)
    .row()
    .text('🗑️ G\'olib kodlarni tozalash', CallbackActions.ADMIN_CLEAR_WINNERS)
    .row()
    .text('🖼️ Rasmlarni yuklash', CallbackActions.ADMIN_UPLOAD_IMAGES);
}

// Upload codes
bot.callbackQuery(CallbackActions.ADMIN_UPLOAD_CODES, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
  }

  const session = getAdminSession(ctx.from.id);
  session.mode = 'upload_codes';

  await ctx.answerCallbackQuery('✅ Kodlar kiritish rejimi faollashtirildi');
  
  try {
    await ctx.editMessageText(
      '📥 <b>Kodlar kiritish</b>\n\nExcel/CSV/TXT fayl yuboring.\nFayl yuborilgach, kodlar avtomatik ravishda bazaga saqlanadi.',
      { 
        parse_mode: 'HTML',
        reply_markup: getAdminKeyboard(),
      },
    );
  } catch (error: any) {
    // Agar xabar o'zgartirib bo'lmasa, yangi xabar yuboramiz
    if (error.error_code === 400 && error.description?.includes('not modified')) {
      await ctx.reply(
        '📥 <b>Kodlar kiritish</b>\n\nExcel/CSV/TXT fayl yuboring.\nFayl yuborilgach, kodlar avtomatik ravishda bazaga saqlanadi.',
        { 
          parse_mode: 'HTML',
          reply_markup: getAdminKeyboard(),
        },
      );
    } else {
      throw error;
    }
  }
});

// Upload winners - kategoriyalar buttonlarini ko'rsatish
bot.callbackQuery(CallbackActions.ADMIN_UPLOAD_WINNERS, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
  }

  const session = getAdminSession(ctx.from.id);
  session.mode = 'upload_winners';

  const tierKeyboard = new InlineKeyboard()
    .text('💎 Premium', `${CallbackActions.ADMIN_UPLOAD_WINNERS}_premium`)
    .row()
    .text('⭐ Standard', `${CallbackActions.ADMIN_UPLOAD_WINNERS}_standard`)
    .row()
    .text('💰 Economy', `${CallbackActions.ADMIN_UPLOAD_WINNERS}_economy`)
    .row()
    .text('🎁 Symbolic', `${CallbackActions.ADMIN_UPLOAD_WINNERS}_symbolic`)
    .row()
    .text('⬅️ Orqaga', CallbackActions.ADMIN_UPLOAD_CODES);

  await ctx.answerCallbackQuery('✅ G\'olib kodlar kiritish rejimi');
  
  try {
    await ctx.editMessageText(
      '🎁 <b>G\'olib kodlarni kiritish</b>\n\nQaysi kategoriyaga tegishli kodlarni yuklamoqchisiz?',
      { 
        parse_mode: 'HTML',
        reply_markup: tierKeyboard,
      },
    );
  } catch (error: any) {
    if (error.error_code === 400 && error.description?.includes('not modified')) {
      await ctx.reply(
        '🎁 <b>G\'olib kodlarni kiritish</b>\n\nQaysi kategoriyaga tegishli kodlarni yuklamoqchisiz?',
        { 
          parse_mode: 'HTML',
          reply_markup: tierKeyboard,
        },
      );
    } else {
      throw error;
    }
  }
});

// Har bir kategoriya uchun alohida handler
['premium', 'standard', 'economy', 'symbolic'].forEach((tier) => {
  bot.callbackQuery(new RegExp(`^${CallbackActions.ADMIN_UPLOAD_WINNERS}_${tier}$`), async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
    }

    const session = getAdminSession(ctx.from.id);
    session.mode = 'upload_winners';
    session.winnerTier = tier as any;

    const tierNames: Record<string, string> = {
      premium: '💎 Premium',
      standard: '⭐ Standard',
      economy: '💰 Economy',
      symbolic: '🎁 Symbolic',
    };

    await ctx.answerCallbackQuery(`✅ ${tierNames[tier]} kategoriyasi tanlandi`);
    
    try {
      await ctx.editMessageText(
        `${tierNames[tier]} <b>kategoriyasi uchun g'olib kodlarni kiritish</b>\n\nExcel/CSV/TXT fayl yuboring.\nFayl yuborilgach, ${tierNames[tier]} kategoriyasidagi g'olib kodlar avtomatik ravishda bazaga saqlanadi.`,
        { 
          parse_mode: 'HTML',
          reply_markup: getAdminKeyboard(),
        },
      );
    } catch (error: any) {
      if (error.error_code === 400 && error.description?.includes('not modified')) {
        await ctx.reply(
          `${tierNames[tier]} <b>kategoriyasi uchun g'olib kodlarni kiritish</b>\n\nExcel/CSV/TXT fayl yuboring.\nFayl yuborilgach, ${tierNames[tier]} kategoriyasidagi g'olib kodlar avtomatik ravishda bazaga saqlanadi.`,
          { 
            parse_mode: 'HTML',
            reply_markup: getAdminKeyboard(),
          },
        );
      } else {
        throw error;
      }
    }
  });
});

// Clear codes
bot.callbackQuery(CallbackActions.ADMIN_CLEAR_CODES, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
  }

  await ctx.answerCallbackQuery();

  const confirmKeyboard = new InlineKeyboard()
    .text('✅ Ha, o\'chirish', `${CallbackActions.ADMIN_CLEAR_CODES}_confirm`)
    .row()
    .text('❌ Bekor qilish', CallbackActions.ADMIN_UPLOAD_CODES);

  await ctx.editMessageText(
    '⚠️ <b>Ehtiyot bo\'ling!</b>\n\nBarcha kodlarni o\'chirishni tasdiqlaysizmi?',
    { 
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard,
    },
  );
});

bot.callbackQuery(new RegExp(`^${CallbackActions.ADMIN_CLEAR_CODES}_confirm$`), async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
  }

  await ctx.answerCallbackQuery();

  try {
    // Avval o'chiriladigan kodlar sonini hisoblaymiz
    const count = await CodeModel.countDocuments({ deletedAt: null });
    
    // Kodlarni to'liq o'chiramiz
    const result = await CodeModel.deleteMany({ deletedAt: null });

    await ctx.editMessageText(
      `✅ <b>Kodlar tozalandi!</b>\n\nO'chirilgan kodlar soni: <b>${result.deletedCount}</b>`,
      { 
        parse_mode: 'HTML',
        reply_markup: getAdminKeyboard(),
      },
    );
  } catch (error: any) {
    await ctx.editMessageText(
      `❌ Xato: ${error.message}`,
      { 
        parse_mode: 'HTML',
        reply_markup: getAdminKeyboard(),
      },
    );
  }
});

// Clear winners
bot.callbackQuery(CallbackActions.ADMIN_CLEAR_WINNERS, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
  }

  await ctx.answerCallbackQuery();

  const confirmKeyboard = new InlineKeyboard()
    .text('✅ Ha, o\'chirish', `${CallbackActions.ADMIN_CLEAR_WINNERS}_confirm`)
    .row()
    .text('❌ Bekor qilish', CallbackActions.ADMIN_UPLOAD_WINNERS);

  await ctx.editMessageText(
    '⚠️ <b>Ehtiyot bo\'ling!</b>\n\nBarcha g\'olib kodlarni o\'chirishni tasdiqlaysizmi?',
    { 
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard,
    },
  );
});

bot.callbackQuery(new RegExp(`^${CallbackActions.ADMIN_CLEAR_WINNERS}_confirm$`), async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
  }

  await ctx.answerCallbackQuery();

  try {
    // Avval o'chiriladigan g'olib kodlar sonini hisoblaymiz
    const count = await WinnerModel.countDocuments({ deletedAt: null });
    
    // G'olib kodlarni to'liq o'chiramiz
    const result = await WinnerModel.deleteMany({ deletedAt: null });

    await ctx.editMessageText(
      `✅ <b>G'olib kodlar tozalandi!</b>\n\nO'chirilgan kodlar soni: <b>${result.deletedCount}</b>`,
      { 
        parse_mode: 'HTML',
        reply_markup: getAdminKeyboard(),
      },
    );
  } catch (error: any) {
    await ctx.editMessageText(
      `❌ Xato: ${error.message}`,
      { 
        parse_mode: 'HTML',
        reply_markup: getAdminKeyboard(),
      },
    );
  }
});

// Upload images
bot.callbackQuery(CallbackActions.ADMIN_UPLOAD_IMAGES, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
  }

  const session = getAdminSession(ctx.from.id);
  session.mode = 'upload_images';

  const imageKeyboard = new InlineKeyboard()
    .text('💎 Premium', `${CallbackActions.ADMIN_UPLOAD_IMAGES}_premium`)
    .row()
    .text('⭐ Standard', `${CallbackActions.ADMIN_UPLOAD_IMAGES}_standard`)
    .row()
    .text('💰 Economy', `${CallbackActions.ADMIN_UPLOAD_IMAGES}_economy`)
    .row()
    .text('🎁 Symbolic', `${CallbackActions.ADMIN_UPLOAD_IMAGES}_symbolic`)
    .row()
    .text('⬅️ Orqaga', CallbackActions.ADMIN_UPLOAD_CODES);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    '🖼️ <b>Rasmlarni yuklash</b>\n\nQaysi turdagi sovg\'a uchun rasm yuklamoqchisiz?',
    { 
      parse_mode: 'HTML',
      reply_markup: imageKeyboard,
    },
  );
});

// Image type selection
['premium', 'standard', 'economy', 'symbolic'].forEach((type) => {
  bot.callbackQuery(new RegExp(`^${CallbackActions.ADMIN_UPLOAD_IMAGES}_${type}$`), async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.answerCallbackQuery('❌ Siz admin emassiz.');
    }

    const session = getAdminSession(ctx.from.id);
    session.imageType = type as any;

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🖼️ <b>${type.toUpperCase()} rasm yuklash</b>\n\nRasm yuboring (foto yoki sticker).`,
      { 
        parse_mode: 'HTML',
        reply_markup: getAdminKeyboard(),
      },
    );
  });
});

export { getAdminSession };

