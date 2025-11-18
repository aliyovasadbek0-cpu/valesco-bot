import bot from '../core/bot';
import { ADMIN_TG_ID } from '../config';
import { CodeModel } from '../../db/models/codes.model';
import { WinnerModel } from '../../db/models/winners.model';
import { GiftModel } from '../../db/models/gifts.model';
import winnersData from '../../config/winners.json';

// G'olib kodlarni codes dan winners ga ko'chirish
bot.command('migrate_winners', async (ctx) => {
  if (ctx.from?.id !== ADMIN_TG_ID) {
    return ctx.reply('❌ Siz admin emassiz.');
  }

  try {
    await ctx.reply('🔄 G\'olib kodlarni ko\'chirish boshlandi...');

    const tierMap = new Map<string, 'premium' | 'standard' | 'economy' | 'symbolic'>();
    
    // winners.json dan barcha kodlarni tier map ga yozamiz
    if ((winnersData as any)?.tiers) {
      for (const [tier, codes] of Object.entries((winnersData as any).tiers)) {
        for (const code of codes as string[]) {
          const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          const pretty = normalized.length >= 10 ? normalized.slice(0, 6) + '-' + normalized.slice(6) : normalized;
          tierMap.set(pretty, tier as any);
        }
      }
    }

    // Codes collection dan barcha kodlarni olamiz
    const allCodes = await CodeModel.find({ deletedAt: null }).lean();
    
    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const code of allCodes) {
      const normalized = code.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      const pretty = normalized.length >= 10 ? normalized.slice(0, 6) + '-' + normalized.slice(6) : normalized;
      
      // Agar kod winners.json da bo'lsa
      if (tierMap.has(pretty)) {
        const tier = tierMap.get(pretty)!;
        
        // Winners collection da mavjudligini tekshiramiz
        const existingWinner = await WinnerModel.findOne({ 
          value: code.value,
          deletedAt: null 
        }).lean();

        if (!existingWinner) {
          // Gift topish yoki yaratish
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

            gift = await GiftModel.create({
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
          }

          // Winner yaratish
          const winnerCount = await WinnerModel.countDocuments();
          await WinnerModel.create({
            id: winnerCount + 1,
            value: code.value,
            tier: tier,
            giftId: gift._id,
            isUsed: code.isUsed,
            usedById: code.usedById,
            usedAt: code.usedAt,
            deletedAt: null,
          });

          // Code ni o'chirish (yoki deletedAt ni o'rnatish)
          await CodeModel.updateOne(
            { _id: code._id },
            { $set: { deletedAt: new Date().toISOString() } }
          );

          migrated++;
        } else {
          skipped++;
        }
      }
    }

    await ctx.reply(`
✅ <b>Ko'chirish yakunlandi!</b>

Ko'chirilgan: <b>${migrated}</b>
O'tkazib yuborilgan: <b>${skipped}</b>
Xatolar: <b>${errors}</b>

Hammasi tayyor! 🚀
    `, { parse_mode: 'HTML' });

  } catch (error: any) {
    console.error("MIGRATION XATOSI:", error);
    await ctx.reply(`❌ Xato: ${error.message}`);
  }
});

