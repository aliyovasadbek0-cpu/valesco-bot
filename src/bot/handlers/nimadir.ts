// import { Types } from 'mongoose';
// import { MyContext } from '../types/types';
// import bot from '../core/bot';
// import { UserModel } from '../../db/models/users.model';
// import { CodeModel } from '../../db/models/codes.model';
// import { CodeLogModel } from '../../db/models/code-logs.model';
// import { SettingsModel } from '../../db/models/settings.model';
// import { contactRequestKeyboard } from '../helpers/keyboard';
// import { mainMenu } from '../commands/start.handler';
// import { phoneCheck } from '../helpers/util';
// import { messageIds } from '../config';
// import winnersData from '../../config/winners.json';
// import nowinnersData from '../../config/nowinners.json';

// const channelId = -1001886860465;

// type GiftTier = 'premium' | 'standard' | 'economy' | 'symbolic';

// const norm = (s: string) => (s || '').trim().toUpperCase();
// const hyphenize = (s: string) => s.includes('-') ? s : (s.length > 6 ? s.slice(0, 6) + '-' + s.slice(6) : s);

// const tierMap = new Map<string, GiftTier>();
// if ((winnersData as any)?.tiers) {
//   for (const [tier, arr] of Object.entries(winnersData.tiers as Record<string, string[]>)) {
//     for (const code of arr || []) tierMap.set(norm(code), tier as GiftTier);
//   }
// }
// const getTier = (code: string) => tierMap.get(norm(code)) ?? null;
// const nowinnerSet = new Set((nowinnersData as string[]).map(norm));

// /* ===============================
//    🧑‍💼 1) ISMNI RO‘YXATDAN O‘TKAZISH
//    =============================== */
// async function registerUserName(ctx: MyContext) {
//   const text = (ctx.message?.text || '').trim();
//   if (!text) return;

//   ctx.session.user.first_name = text;
//   if (!ctx.session.user.db_id) ctx.session.user.db_id = new Types.ObjectId();

//   ctx.session.user_state = 'REGISTER_PHONE_NUMBER';
  
//   return await ctx.reply(ctx.i18n.t('auth.requestPhoneNumber'), {
//     reply_markup: contactRequestKeyboard(ctx.i18n.t('auth.sendContact')),
//     parse_mode: 'HTML',
//   });
// }

// /* ===============================
//    📱 2) TELEFON RAQAMNI QABUL QILISH
//    =============================== */
// async function registerUserPhoneNumber(ctx: MyContext) {
//   const text = (ctx.message?.text || '').replace(/\s+/g, '');
//   const contact = ctx.message?.contact;
//   let phone = '';

//   if (text && phoneCheck(text)) phone = text;
//   else if (contact?.phone_number && phoneCheck(contact.phone_number)) phone = contact.phone_number;
//   else return await ctx.reply(ctx.i18n.t('validation.invalidPhoneNumber'));

//   phone = phone.replace('+', '');

//   await UserModel.findByIdAndUpdate(
//     ctx.session.user.db_id,
//     {
//       $set: {
//         tgId: ctx.from?.id,
//         firstName: ctx.session.user.first_name,
//         phoneNumber: phone,
//         lang: ctx.session.user.lang,
//         tgFirstName: ctx.from?.first_name || '',
//         tgLastName: ctx.from?.last_name || '',
//         lastUseAt: new Date().toISOString(),
//       },
//     },
//     { upsert: true }
//   );

//   ctx.session.user_state = '';
  
//   const tmp = await ctx.reply('.', { reply_markup: { remove_keyboard: true } });
//   await ctx.api.deleteMessage(tmp.chat.id, tmp.message_id).catch(() => {});

//   return await mainMenu(ctx);
// }

// /* ===============================
//    🎟 3) KODNI TEKSHIRISH
//    =============================== */
// async function checkCode(ctx: MyContext) {
//   const lang = ctx.session.user.lang as 'uz' | 'ru';
//   if (!ctx.session.user.first_name || ctx.session.user_state !== '') return;

//   const usedCount = await CodeModel.countDocuments({ usedById: ctx.session.user.db_id, deletedAt: null });
//   const settings = await SettingsModel.findOne({ deletedAt: null });
//   if (settings?.codeLimitPerUser?.status && usedCount >= settings.codeLimitPerUser.value) {
//     return await ctx.api.forwardMessage(ctx.from.id, channelId, messageIds[lang].codeUsageLimit);
//   }

//   const text = ctx.message?.text || '';
//   const up = norm(text);
//   const hy = hyphenize(up);
//   const variants = Array.from(new Set([text, up, hy]));

//   const tier = getTier(hy);
//   const isNoWin = nowinnerSet.has(up);

//   const code = await CodeModel.findOne({ $and: [ { $or: variants.map(v => ({ value: v })) }, { deletedAt: null } ] }).lean();

//   await CodeLogModel.create({ codeId: code?._id ?? null, userId: ctx.session.user.db_id, value: text });

//   if (!tier && !isNoWin) return await ctx.api.forwardMessage(ctx.from.id, channelId, messageIds[lang].codeFake);
//   if (code?.isUsed && code.usedById?.toString() !== ctx.session.user.db_id.toString()) return await ctx.api.forwardMessage(ctx.from.id, channelId, messageIds[lang].codeUsed);

//   const nowIso = new Date().toISOString();
//   if (!code) {
//     await CodeModel.create({ value: hy, version: 2, giftId: null, isUsed: true, usedById: ctx.session.user.db_id, usedAt: nowIso });
//   } else if (!code.isUsed) {
//     await CodeModel.updateOne({ _id: code._id }, { $set: { usedById: ctx.session.user.db_id, usedAt: nowIso, isUsed: true } });
//   }

//   if (!tier && isNoWin) return await ctx.api.forwardMessage(ctx.from.id, channelId, messageIds[lang].codeReal);
//   return await ctx.api.forwardMessage(ctx.from.id, channelId, messageIds[lang].codeWithGift[tier!]);
// }

// /* ===============================
//    📩 MESSAGE HANDLER
//    =============================== */
// const onMessageHandler = async (ctx: MyContext) => {
//   switch (ctx.session.user_state) {
//     case 'REGISTER_NAME':
//       return registerUserName(ctx);
//     case 'REGISTER_PHONE_NUMBER':
//       return registerUserPhoneNumber(ctx);
//     default:
//       return checkCode(ctx);
//   }
// };

// bot.on('message', onMessageHandler);
