import { PipelineStage } from 'mongoose';
import { Code, CodeModel } from '../../../db/models/codes.model';
import { UserModel } from '../../../db/models/users.model';
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
  constructor(private readonly codeModel: typeof CodeModel = CodeModel) {}

  async getSummary() {
    const now = new Date();
    now.setUTCHours(23, 59, 59, 999);
    const weekStart = new Date(now);
    weekStart.setUTCHours(0, 0, 0, 0);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);

    const [totalCodes, usedCodes, availableCodes, activeUsers, weeklyUsageRaw, recentActivityRaw] =
      await Promise.all([
        this.codeModel.countDocuments({ deletedAt: null }),
        this.codeModel.countDocuments({ deletedAt: null, isUsed: true, usedAt: { $ne: null } }),
        this.codeModel.countDocuments({ deletedAt: null, isUsed: false }),
        this.getActiveUsersCount(),
        this.getWeeklyUsage(weekStart, now),
        this.getRecentActivity(10),
      ]);

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
    const res = await this.codeModel
      .aggregate<{ count: number }>([
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
          $group: {
            _id: '$usedById',
          },
        },
        {
          $count: 'count',
        },
      ])
      .exec();

    return res[0]?.count ?? 0;
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

    return this.codeModel.aggregate<{ _id: string; count: number }>(pipeline).exec();
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

    return this.codeModel
      .aggregate<{
        _id: Code['_id'];
        value: string;
        usedAtDate: Date | null;
        user: any[];
        gift: any[];
      }>([
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
        {
          $sort: { usedAtDate: -1 },
        },
        {
          $limit: limit,
        },
        $lookupUser,
        $lookupGift,
        {
          $project: {
            _id: 1,
            value: 1,
            usedAtDate: 1,
            user: { $arrayElemAt: ['$user', 0] },
            gift: { $arrayElemAt: ['$gift', 0] },
          },
        },
      ])
      .exec();
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

