import { PipelineStage } from 'mongoose';
import { Code, CodeModel } from '../../../db/models/codes.model';
import { WinnerModel } from '../../../db/models/winners.model';
import { UserModel, UserRole } from '../../../db/models/users.model';
import { COLLECTIONS } from '../../../common/constant/tables';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface WeeklyUsageItem {
  date: string;
  dayLabel: string;
  usedCodes: number;
}

interface RecentActivityItem {
  id: string;
  value: string;
  usedAt: string | null;
  gift: {
    id: string;
    name: string;
  } | null;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
  } | null;
}

interface OverviewTotals {
  totalCodes: number;
  usedCodes: number;
  availableCodes: number;
  activeUsers: number;
}

export class OverviewService {
  constructor(
    private readonly codeModel: typeof CodeModel = CodeModel,
    private readonly winnerModel: typeof WinnerModel = WinnerModel,
  ) {}

  async getSummary() {
    const now = new Date();
    now.setUTCHours(23, 59, 59, 999);
    const weekStart = new Date(now);
    weekStart.setUTCHours(0, 0, 0, 0);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);

    // Barcha kodlar - CodeModel + WinnerModel
    const [
      totalCodesCount,
      totalWinnersCount,
      usedCodesCount,
      usedWinnersCount,
      availableCodesCount,
      availableWinnersCount,
      activeUsers,
      weeklyUsageRaw,
      recentActivityRaw,
    ] = await Promise.all([
      // Jami kodlar soni (oddiy + g'olib)
      this.codeModel.countDocuments({ deletedAt: null }),
      this.winnerModel.countDocuments({ deletedAt: null }),
      // Ishlatilgan kodlar soni (oddiy + g'olib)
      this.codeModel.countDocuments({ deletedAt: null, isUsed: true, usedAt: { $ne: null } }),
      this.winnerModel.countDocuments({ deletedAt: null, isUsed: true, usedAt: { $ne: null } }),
      // Ishlatilmagan kodlar soni (oddiy + g'olib)
      this.codeModel.countDocuments({ deletedAt: null, isUsed: false }),
      this.winnerModel.countDocuments({ deletedAt: null, isUsed: false }),
      // Active users (oddiy + g'olib kodlardan gift olganlar)
      this.getActiveUsersCount(),
      // Weekly usage (oddiy + g'olib kodlar)
      this.getWeeklyUsage(weekStart, now),
      // Recent activity (oddiy + g'olib kodlar)
      this.getRecentActivity(10),
    ]);

    // Birlashtirilgan hisoblar
    const totalCodes = totalCodesCount + totalWinnersCount;
    const usedCodes = usedCodesCount + usedWinnersCount;
    const availableCodes = availableCodesCount + availableWinnersCount;

    const weeklyUsage = this.normalizeWeeklyUsage(weeklyUsageRaw, weekStart);
    const recentActivity = this.normalizeRecentActivity(recentActivityRaw);

    const totals: OverviewTotals = {
      totalCodes,
      usedCodes,
      availableCodes,
      activeUsers,
    };

    return {
      totals,
      weeklyUsage,
      recentActivity,
    };
  }

  private async getActiveUsersCount(): Promise<number> {
    // Oddiy kodlardan gift olgan userlar (admin'larsiz)
    const codeUsers = await this.codeModel
      .aggregate<{ userId: string }>([
        {
          $match: {
            deletedAt: null,
            isUsed: true,
            usedAt: { $ne: null },
            giftId: { $ne: null },
            usedById: { $ne: null },
          },
        },
        {
          $lookup: {
            from: COLLECTIONS.users,
            localField: 'usedById',
            foreignField: '_id',
            as: 'user',
          },
        },
        {
          $match: {
            'user.role': { $nin: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
          },
        },
        {
          $group: {
            _id: '$usedById',
          },
        },
        {
          $project: {
            userId: { $toString: '$_id' },
          },
        },
      ])
      .exec();

    // G'olib kodlardan gift olgan userlar (admin'larsiz)
    const winnerUsers = await this.winnerModel
      .aggregate<{ userId: string }>([
        {
          $match: {
            deletedAt: null,
            isUsed: true,
            usedAt: { $ne: null },
            giftId: { $ne: null },
            usedById: { $ne: null },
          },
        },
        {
          $lookup: {
            from: COLLECTIONS.users,
            localField: 'usedById',
            foreignField: '_id',
            as: 'user',
          },
        },
        {
          $match: {
            'user.role': { $nin: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
          },
        },
        {
          $group: {
            _id: '$usedById',
          },
        },
        {
          $project: {
            userId: { $toString: '$_id' },
          },
        },
      ])
      .exec();

    // Birlashtirish va unique userlar sonini topish
    const allUserIds = new Set<string>();
    codeUsers.forEach((u) => allUserIds.add(u.userId));
    winnerUsers.forEach((u) => allUserIds.add(u.userId));

    return allUserIds.size;
  }

  private async getWeeklyUsage(from: Date, to: Date) {
    const pipeline: PipelineStage[] = [
      {
        $match: {
          deletedAt: null,
          isUsed: true,
          usedAt: { $ne: null },
        },
      },
      {
        $addFields: {
          usedAtDate: {
            $cond: [
              { $ifNull: ['$usedAt', false] },
              { $toDate: '$usedAt' },
              null,
            ],
          },
        },
      },
      {
        $match: {
          usedAtDate: { $ne: null, $gte: from, $lte: to },
        },
      },
      {
        $project: {
          usageDate: {
            $dateToString: {
              date: '$usedAtDate',
              format: '%Y-%m-%d',
            },
          },
        },
      },
      {
        $group: {
          _id: '$usageDate',
          count: { $sum: 1 },
        },
      },
    ];

    // Oddiy kodlar va g'olib kodlar uchun alohida aggregate
    const [codeUsage, winnerUsage] = await Promise.all([
      this.codeModel.aggregate<{ _id: string; count: number }>(pipeline).exec(),
      this.winnerModel.aggregate<{ _id: string; count: number }>(pipeline).exec(),
    ]);

    // Birlashtirish - bir xil kunlarni qo'shish
    const usageMap = new Map<string, number>();
    codeUsage.forEach((item) => {
      const existing = usageMap.get(item._id) || 0;
      usageMap.set(item._id, existing + item.count);
    });
    winnerUsage.forEach((item) => {
      const existing = usageMap.get(item._id) || 0;
      usageMap.set(item._id, existing + item.count);
    });

    return Array.from(usageMap.entries()).map(([date, count]) => ({ _id: date, count }));
  }

  private async getRecentActivity(limit: number) {
    const $lookupUser: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.users,
        let: { usedById: '$usedById' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$_id', '$$usedById'] },
            },
          },
          {
            $project: {
              _id: 1,
              firstName: 1,
              lastName: 1,
              phoneNumber: 1,
              tgFirstName: 1,
              tgLastName: 1,
            },
          },
        ],
        as: 'user',
      },
    };

    const $lookupGift: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.gifts,
        let: { giftId: '$giftId' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$_id', '$$giftId'] },
            },
          },
          {
            $project: {
              _id: 1,
              name: 1,
            },
          },
        ],
        as: 'gift',
      },
    };

    const commonPipeline: PipelineStage[] = [
      {
        $match: {
          deletedAt: null,
          isUsed: true,
          usedAt: { $ne: null },
        },
      },
      {
        $addFields: {
          usedAtDate: {
            $cond: [
              { $ifNull: ['$usedAt', false] },
              { $toDate: '$usedAt' },
              null,
            ],
          },
        },
      },
      {
        $match: { usedAtDate: { $ne: null } },
      },
      $lookupUser,
      $lookupGift,
      {
        $match: {
          'user.role': { $nin: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
        },
      },
      {
        $project: {
          _id: 1,
          value: 1,
          usedAtDate: 1,
          user: { $arrayElemAt: ['$user', 0] },
          gift: { $arrayElemAt: ['$gift', 0] },
        },
      },
    ];

    // Oddiy kodlar va g'olib kodlar uchun alohida aggregate
    const [codeActivity, winnerActivity] = await Promise.all([
      this.codeModel
        .aggregate<{
          _id: any;
          value: string;
          usedAtDate: Date | null;
          user: any;
          gift: any;
        }>([...commonPipeline, { $sort: { usedAtDate: -1 } }, { $limit: limit }])
        .exec(),
      this.winnerModel
        .aggregate<{
          _id: any;
          value: string;
          usedAtDate: Date | null;
          user: any;
          gift: any;
        }>([...commonPipeline, { $sort: { usedAtDate: -1 } }, { $limit: limit }])
        .exec(),
    ]);

    // Birlashtirish va sort qilish (eng yangilari birinchi)
    const allActivity = [...codeActivity, ...winnerActivity].sort((a, b) => {
      const aDate = a.usedAtDate ? new Date(a.usedAtDate).getTime() : 0;
      const bDate = b.usedAtDate ? new Date(b.usedAtDate).getTime() : 0;
      return bDate - aDate;
    });

    return allActivity.slice(0, limit);
  }

  private normalizeWeeklyUsage(raw: { _id: string; count: number }[], from: Date): WeeklyUsageItem[] {
    const usageMap = raw.reduce<Record<string, number>>((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    const result: WeeklyUsageItem[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(from);
      day.setUTCDate(from.getUTCDate() + i);
      const isoDate = day.toISOString().split('T')[0];
      result.push({
        date: isoDate,
        dayLabel: DAY_LABELS[day.getUTCDay()],
        usedCodes: usageMap[isoDate] ?? 0,
      });
    }
    return result;
  }

  private normalizeRecentActivity(raw: any[]): RecentActivityItem[] {
    return raw.map((item) => {
      const user = item.user || null;
      const firstName = user?.firstName || user?.tgFirstName || '';
      const lastName = user?.lastName || user?.tgLastName || '';
      const phoneNumber = user?.phoneNumber || '';
      const gift = item.gift || null;

      return {
        id: item._id?.toString(),
        value: item.value,
        usedAt: item.usedAtDate ? new Date(item.usedAtDate).toISOString() : null,
        user: user
          ? {
              id: user._id?.toString(),
              firstName,
              lastName,
              phoneNumber,
            }
          : null,
        gift: gift
          ? {
              id: gift._id?.toString(),
              name: gift.name,
            }
          : null,
      };
    });
  }
}



