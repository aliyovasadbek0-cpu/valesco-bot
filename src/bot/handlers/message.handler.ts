import { CodeModel } from '../../db/models/codes.model';
import { WinnerModel } from '../../db/models/winners.model';
import { MyContext } from '../types/types';
import bot from '../core/bot';
import { UserModel } from '../../db/models/users.model';
import { contactRequestKeyboard } from '../helpers/keyboard';
import { ADMIN_TG_ID, FORWARD_MESSAGES_CHANNEL_ID, messageIds } from '../config';
import { CodeLogModel } from '../../db/models/code-logs.model';
import { Types } from 'mongoose';
import { SettingsModel } from '../../db/models/settings.model';
import { BotLanguage } from '../core/middleware';
import { GiftModel } from '../../db/models/gifts.model';
import winnersData from '../../config/winners.json';
import { phoneCheck } from '../helpers/util';

type GiftTier = 'premium' | 'standard' | 'economy' | 'symbolic';

const norm = (s: string) => (s || '').trim().toUpperCase().replace(/-/g, '');
const hyphenize = (s: string) =>
  s.includes('-') ? s : s.length > 6 ? s.slice(0, 6) + '-' + s.slice(6) : s;

const tierMap = new Map<string, GiftTier>();
if ((winnersData as any)?.tiers) {
  for (const [tier, arr] of Object.entries(winnersData.tiers as Record<string, string[]>)) {
    for (const code of arr || []) tierMap.set(norm(code), tier as GiftTier);
  }
}
const getTier = (code: string): GiftTier | null => tierMap.get(norm(code)) ?? null;

// ======================
// 1) ISM RO‘YXATDAN O‘TKAZISH
// ======================
async function registerUserName(ctx: MyContext) {
  const text = ctx.message!.text?.trim();
  if (!text) return;

  let user = await UserModel.findOne({ tgId: ctx.from?.id }).lean();

  if (user) {
    await UserModel.findByIdAndUpdate(user._id, { $set: { firstName: text } });
    ctx.session.user.db_id = user._id;
  } else {
    const count = await UserModel.countDocuments();
    const newUser = await new UserModel({
      _id: ctx.session.user.db_id,
      id: count + 1,
      tgId: ctx.from?.id,
      tgFirstName: ctx.from?.first_name || '',
      tgLastName: ctx.from?.last_name || '',
      firstName: text,
      lang: ctx.session.user.lang || 'uz',
      phoneNumber: '',
      lastUseAt: new Date(),
    }).save();
    ctx.session.user.db_id = newUser._id;
  }

  ctx.session.user.first_name = text;
  ctx.session.user_state = 'REGISTER_PHONE_NUMBER';
  ctx.session.is_editable_message = false;
  ctx.session.is_editable_image = false;

  return ctx.reply(ctx.i18n.t('auth.requestPhoneNumber'), {
    reply_markup: contactRequestKeyboard(ctx.i18n.t('auth.sendContact')),
    parse_mode: 'HTML',
  });
}

// ======================
// 2) TELEFON RAQAM QABUL QILISH
// ======================
async function registerUserPhoneNumber(ctx: MyContext) {
  const text = ctx.message?.text?.replace(/\s+/g, '').replace('+', '');
  const contact = ctx.message?.contact;
  let phone = '';

  if (text && phoneCheck(text)) phone = text;
  else if (contact?.phone_number && phoneCheck(contact.phone_number)) phone = contact.phone_number;
  else return ctx.reply(ctx.i18n.t('validation.invalidPhoneNumber'));

  phone = phone.replace('+', '');

  let user = await UserModel.findOne({ tgId: ctx.from?.id }).lean();

  if (user) {
    await UserModel.findByIdAndUpdate(user._id, {
      $set: { phoneNumber: phone, firstName: ctx.session.user.first_name || user.firstName || '' },
    });
    ctx.session.user.db_id = user._id;
  } else {
    const count = await UserModel.countDocuments();
    const newUser = await new UserModel({
      _id: ctx.session.user.db_id,
      id: count + 1,
      tgId: ctx.from?.id,
      tgFirstName: ctx.from?.first_name || '',
      tgLastName: ctx.from?.last_name || '',
      firstName: ctx.session.user.first_name || '',
      lang: ctx.session.user.lang || 'uz',
      phoneNumber: phone,
      lastUseAt: new Date(),
    }).save();
    ctx.session.user.db_id = newUser._id;
  }

  ctx.session.user_state = '';
  ctx.session.is_editable_message = false;
  ctx.session.is_editable_image = false;

  const msg = await ctx.reply('.', { reply_markup: { remove_keyboard: true } });
  await ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

  // Telefon kiritilgandan keyin kod so‘rash xabarini yuborish
  await ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[ctx.i18n.languageCode as BotLanguage].start);

  return;
}

// ======================
// 3) KOD TEKSHIRISH
// ======================
async function checkCode(ctx: MyContext) {
  const lang = ctx.i18n.languageCode as BotLanguage;

  const MESSAGES: Record<BotLanguage, Record<string, string>> = {
    uz: { invalidFormat: '❌ Noto‘g‘ri kod formati kiritdingiz.' },
    ru: { invalidFormat: '❌ Вы ввели неверный код.' },
  };

  if (ctx.session.is_editable_message && ctx.session.main_menu_message) {
    await ctx.api.editMessageReplyMarkup(ctx.message!.chat.id, ctx.session.main_menu_message.message_id, { reply_markup: { inline_keyboard: [] } });
    ctx.session.main_menu_message = undefined;
  }

  ctx.session.is_editable_message = false;
  ctx.session.is_editable_image = false;

  const usedCount = await CodeModel.countDocuments({ usedById: ctx.session.user.db_id, deletedAt: null });
  const settings = await SettingsModel.findOne({ deletedAt: null }).lean();

  if (settings?.codeLimitPerUser?.status && usedCount >= (settings.codeLimitPerUser?.value || 0)) {
    return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeUsageLimit);
  }

  let rawText = (ctx.message?.text ?? '').trim().toUpperCase();
  if (/^[A-Z]{6}\d{4}$/.test(rawText)) rawText = `${rawText.slice(0, 6)}-${rawText.slice(6)}`;

  if (!/^[A-Z]{6}-\d{4}$/.test(rawText)) {
    return ctx.reply(MESSAGES[lang]?.invalidFormat || MESSAGES.uz.invalidFormat, { parse_mode: 'HTML' });
  }

  const normalized = norm(rawText);
  const hy = hyphenize(rawText);

  // AVVAL WINNERS DAN TEKSHIRISH (g'olib kodlar muhimroq)
  let winner = await WinnerModel.findOne({
    $or: [{ value: rawText }, { value: hy }, { value: normalized }, { value: rawText.replace(/-/g, '') }],
    deletedAt: null,
  }).lean();

  // Agar winners da topilmasa, codes dan tekshirish
  let code = null;
  if (!winner) {
    code = await CodeModel.findOne({
      $or: [{ value: rawText }, { value: hy }, { value: normalized }, { value: rawText.replace(/-/g, '') }],
      deletedAt: null,
    }).lean();
  }

  await CodeLogModel.create({
    _id: new Types.ObjectId(),
    userId: ctx.session.user.db_id,
    value: ctx.message?.text || '',
    codeId: code?._id ?? winner?._id ?? null,
  }).catch(() => {});

  // Agar hech qayerda topilmasa
  if (!code && !winner) {
    return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeFake);
  }

  // Winner kod topilgan bo'lsa
  if (winner) {
    console.log("WINNER KOD TOPILDI:", {
      code: rawText,
      winnerId: winner._id,
      tier: winner.tier,
      isUsed: winner.isUsed,
      usedById: winner.usedById,
      currentUserId: ctx.session.user.db_id
    });

    if (winner.isUsed && winner.usedById?.toString() !== ctx.session.user.db_id.toString()) {
      return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeUsed);
    }

    if (!winner.isUsed) {
      await WinnerModel.updateOne(
        { _id: winner._id },
        { $set: { isUsed: true, usedAt: new Date().toISOString(), usedById: ctx.session.user.db_id } }
      );
    }

    // Winner kod uchun tier aniqlash
    const tier = winner.tier as GiftTier | null;
    console.log("WINNER TIER:", tier);
    
    if (tier) {
      const gift = await GiftModel.findOne({ type: tier, deletedAt: null }).lean();
      console.log("GIFT TOPILDI:", gift ? { id: gift._id, type: gift.type, name: gift.name } : "GIFT TOPILMADI");
      
      if (gift) {
        await GiftModel.updateOne({ _id: gift._id }, { $inc: { usedCount: 1 } });
        console.log("GIFT XABARI YUBORILMOQDA:", messageIds[lang].codeWithGift[tier]);
        return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeWithGift[tier]);
      } else {
        console.error(`GIFT TOPILMADI! Tier: ${tier}`);
        // Gift topilmasa ham, winner kod bo'lgani uchun xabar yuboramiz
        return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeReal);
      }
    } else {
      console.error("WINNER KODDA TIER YO'Q!", winner);
      // Tier null bo'lsa ham, winner kod bo'lgani uchun xabar yuboramiz
      return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeReal);
    }
  }

  // Oddiy kod topilgan bo'lsa
  if (code.isUsed && code.usedById?.toString() !== ctx.session.user.db_id.toString()) {
    return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeUsed);
  }

  if (!code.isUsed) {
    await CodeModel.updateOne(
      { _id: code._id },
      { $set: { isUsed: true, usedAt: new Date().toISOString(), usedById: ctx.session.user.db_id } }
    );
  }

  const tier = getTier(rawText) || getTier(normalized) || getTier(hy);

  if (tier) {
    const gift = await GiftModel.findOne({ type: tier, deletedAt: null }).lean();
    if (gift) {
      await GiftModel.updateOne({ _id: gift._id }, { $inc: { usedCount: 1 } });
      return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeWithGift[tier]);
    }
  }

  return ctx.api.forwardMessage(ctx.from.id, FORWARD_MESSAGES_CHANNEL_ID, messageIds[lang].codeReal);
}

// ======================
// ASOSIY MESSAGE HANDLER
// =====================
const onMessageHandler = async (ctx: MyContext) => {
  // Admin document yuborsa - document handler ishlaydi, bu yerdan o'tkazmaymiz
  if (ctx.message?.document && ctx.from?.id === ADMIN_TG_ID) {
    return; // document handler ishlaydi
  }

  // Faqat oddiy user Excel yuborsa to'xtatamiz
  if (ctx.message?.document && ctx.from?.id !== ADMIN_TG_ID) {
    return;
  }

  // Qolgan kodlar (ism, telefon, kod tekshirish)
  switch (ctx.session.user_state) {
    case 'REGISTER_NAME':
      return registerUserName(ctx);
    case 'REGISTER_PHONE_NUMBER':
      return registerUserPhoneNumber(ctx);
    default:
      return checkCode(ctx);
  }
};
bot.on('message', onMessageHandler);
