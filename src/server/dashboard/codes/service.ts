import { PipelineStage, Types } from 'mongoose';
import { CodeModel } from '../../../db/models/codes.model';
import { WinnerModel } from '../../../db/models/winners.model';
import { UserRole } from '../../../db/models/users.model';
import { DashboardGiftCodesDto, DashboardGiftCodeStatus } from '../gift-codes/class-validator';
import { DashboardCodesDto } from './class-validator';
import { COLLECTIONS } from '../../../common/constant/tables';

interface AggregateOptions {
  query: DashboardGiftCodesDto | DashboardCodesDto;
  baseFilter?: PipelineStage.Match['$match'];
  postLookupMatches?: PipelineStage[];
}

export class DashboardCodesService {
  constructor(private readonly codeModel = CodeModel, private readonly winnerModel = WinnerModel) {}

  async getGiftCodes(query: DashboardGiftCodesDto) {
    // Bu endpoint faqat sovg'a olganlar ro'yxatini qaytaradi
    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    return this.aggregateGiftReceivers(query);
  }

  async getWinnerCodes(query: DashboardGiftCodesDto) {
    // G'olib kodlar ro'yxati (faqat ishlatilganlar)
    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    return this.aggregateWinnerCodes({
      query,
    });
  }

  private async aggregateWinnerCodes({ query }: { query: DashboardGiftCodesDto }) {
    const baseFilter: PipelineStage.Match['$match'] = {
      deletedAt: null,
    };

    const pipeline: PipelineStage[] = [
      { $match: baseFilter },
      this.lookupUserStage('usedById'),
      this.lookupGiftStage('giftId'),
      this.flattenLookupStage(),
      this.usedAtStage(),
      this.derivedFieldsStage(),
    ];

    const searchStage = this.buildSearchStage(query.search);
    if (searchStage) {
      pipeline.push(searchStage);
    }

    const $sort: PipelineStage.Sort = { $sort: { usedAtDate: -1, id: 1 } };
    const $skip: PipelineStage.Skip = { $skip: (query.page - 1) * query.limit };
    const $limit: PipelineStage.Limit = { $limit: query.limit };

    const result = await this.winnerModel.aggregate<{
      data: any[];
      total: [{ total: number }];
    }>([
      {
        $facet: {
          data: [...pipeline as any[], $sort, $skip, $limit],
          total: [...pipeline as any[], { $count: 'total' }],
        },
      },
    ]);

    const records = result[0]?.data ?? [];
    const total = result[0]?.total?.[0]?.total ?? 0;

    return {
      data: records.map((record) => this.transformRecord(record)),
      total,
    };
  }

  async getCodes(query: DashboardCodesDto) {
    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    // Ikkala collection'dan ham ma'lumot olamiz
    return this.aggregateFromBothCollections(query);
  }

  private buildBaseFilter(): PipelineStage.Match['$match'] {
    return {
      deletedAt: null,
    };
  }

  private async aggregateCodes({ query, baseFilter = this.buildBaseFilter(), postLookupMatches = [] }: AggregateOptions) {
    const pipeline: PipelineStage[] = [
      { $match: baseFilter },
      this.lookupUserStage(),
      this.lookupGiftStage(),
      this.flattenLookupStage(),
      this.usedAtStage(),
      this.derivedFieldsStage(),
      ...postLookupMatches,
    ];

    const searchStage = this.buildSearchStage(query.search);
    if (searchStage) {
      pipeline.push(searchStage);
    }

    const $sort: PipelineStage.Sort = { $sort: { usedAtDate: -1, id: 1 } };
    const $skip: PipelineStage.Skip = { $skip: (query.page - 1) * query.limit };
    const $limit: PipelineStage.Limit = { $limit: query.limit };

    const result = await this.codeModel.aggregate<{
      data: any[];
      total: [{ total: number }];
    }>([
      {
        $facet: {
          data: [...pipeline as any[], $sort, $skip, $limit],
          total: [...pipeline as any[], { $count: 'total' }],
        },
      },
    ]);

    const records = result[0]?.data ?? [];
    const total = result[0]?.total?.[0]?.total ?? 0;

    return {
      data: records.map((record) => this.transformRecord(record)),
      total,
    };
  }

  private lookupUserStage(usedByIdField = 'usedById'): PipelineStage.Lookup {
    return {
      $lookup: {
        from: COLLECTIONS.users,
        let: { usedById: `$${usedByIdField}` },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$_id', '$$usedById'] },
              role: { $nin: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
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
        as: 'usedBy',
      },
    };
  }

  private lookupGiftStage(giftIdField = 'giftId'): PipelineStage.Lookup {
    return {
      $lookup: {
        from: COLLECTIONS.gifts,
        let: { giftId: `$${giftIdField}` },
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
  }

  private flattenLookupStage(): PipelineStage.AddFields {
    return {
      $addFields: {
        usedBy: { $arrayElemAt: ['$usedBy', 0] },
        gift: { $arrayElemAt: ['$gift', 0] },
      },
    };
  }

  private usedAtStage(): PipelineStage.AddFields {
    return {
      $addFields: {
        usedAtDate: {
          $cond: [
            { $ifNull: ['$usedAt', false] },
            { $toDate: '$usedAt' },
            null,
          ],
        },
      },
    };
  }

  private derivedFieldsStage(): PipelineStage.AddFields {
    return {
      $addFields: {
        giftName: { $ifNull: ['$gift.name', ''] },
        usedByFirstName: { $ifNull: ['$usedBy.firstName', '$usedBy.tgFirstName'] },
        usedByLastName: { $ifNull: ['$usedBy.lastName', '$usedBy.tgLastName'] },
        usedByPhone: { $ifNull: ['$usedBy.phoneNumber', ''] },
        usedByFullName: {
          $trim: {
            input: {
              $concat: [
                {
                  $ifNull: [
                    { $ifNull: ['$usedBy.firstName', '$usedBy.tgFirstName'] },
                    '',
                  ],
                },
                ' ',
                {
                  $ifNull: [
                    { $ifNull: ['$usedBy.lastName', '$usedBy.tgLastName'] },
                    '',
                  ],
                },
              ],
            },
          },
        },
        idString: { $toString: '$id' },
        usedAtFormatted: {
          $cond: [
            { $ifNull: ['$usedAtDate', false] },
            {
              $dateToString: {
                date: '$usedAtDate',
                format: '%Y-%m-%d %H:%M:%S',
              },
            },
            null,
          ],
        },
      },
    };
  }

  private buildSearchStage(search?: string): PipelineStage.Match | null {
    if (!search) {
      return null;
    }

    const regex = new RegExp(this.escapeRegex(search), 'i');
    return {
      $match: {
        $or: [
          { value: { $regex: regex } },
          { giftName: { $regex: regex } },
          { usedByFirstName: { $regex: regex } },
          { usedByLastName: { $regex: regex } },
          { usedByFullName: { $regex: regex } },
          { usedByPhone: { $regex: regex } },
          { usedAtFormatted: { $regex: regex } },
          { idString: { $regex: regex } },
        ],
      },
    };
  }

  private transformRecord(record: any) {
    const gift = record.gift
      ? {
          id: record.gift._id?.toString(),
          name: record.gift.name,
        }
      : null;

    const usedBy = record.usedBy
      ? {
          id: record.usedBy._id?.toString(),
          firstName: record.usedByFirstName || '',
          lastName: record.usedByLastName || '',
          fullName: record.usedByFullName?.trim() || '',
          phoneNumber: record.usedByPhone || '',
        }
      : null;

    return {
      id: record._id?.toString(),
      index: record.id,
      value: record.value,
      gift,
      usedBy,
      usedAt: record.usedAtDate ? new Date(record.usedAtDate).toISOString() : null,
      usedAtFormatted: record.usedAtFormatted || null,
    };
  }

  async searchAll(query: DashboardCodesDto) {
    // Keng qamrovli qidiruv - kodlar, g'olib kodlar va foydalanuvchilar orasida
    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    if (!query.search || !query.search.trim()) {
      return { data: [], total: 0 };
    }

    const searchTerm = query.search.trim();
    const regex = new RegExp(this.escapeRegex(searchTerm), 'i');
    const searchNum = isNaN(Number(searchTerm)) ? null : Number(searchTerm);

    // 1. Foydalanuvchilarni topish (admin'larsiz)
    const users = await this.codeModel.db
      .collection(COLLECTIONS.users)
      .find({
        deletedAt: null,
        role: { $nin: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
        $or: [
          { firstName: { $regex: regex } },
          { lastName: { $regex: regex } },
          { phoneNumber: { $regex: regex } },
          { tgFirstName: { $regex: regex } },
          { tgLastName: { $regex: regex } },
        ],
      })
      .limit(50)
      .toArray();

    const userIds = users.map((u) => u._id);

    // 2. Kodlar orasida qidirish (value, id, yoki foydalanuvchi bo'yicha)
    const codesPipeline: PipelineStage[] = [
      {
        $match: {
          deletedAt: null,
          $or: [
            { value: { $regex: regex } },
            ...(searchNum ? [{ id: searchNum }] : []),
            ...(userIds.length ? [{ usedById: { $in: userIds } }] : []),
          ],
        },
      },
      ...(userIds.length
        ? [
            {
              $lookup: {
                from: COLLECTIONS.users,
                let: { userId: '$usedById' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$_id', '$$userId'] },
                      deletedAt: null,
                      role: { $nin: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
                      $or: [
                        { firstName: { $regex: regex } },
                        { lastName: { $regex: regex } },
                        { phoneNumber: { $regex: regex } },
                        { tgFirstName: { $regex: regex } },
                        { tgLastName: { $regex: regex } },
                      ],
                    },
                  },
                ],
                as: 'matchedUsers',
              },
            },
            {
              $match: {
                $or: [
                  { value: { $regex: regex } },
                  ...(searchNum ? [{ id: searchNum }] : []),
                  { 'matchedUsers.0': { $exists: true } },
                ],
              },
            },
          ]
        : []),
      this.lookupUserStage(),
      this.lookupGiftStage(),
      this.flattenLookupStage(),
      this.usedAtStage(),
      this.derivedFieldsStage(),
      this.buildSearchStage(searchTerm) || { $match: {} },
    ];

    // 3. G'olib kodlar orasida qidirish (value, id, yoki foydalanuvchi bo'yicha)
    const winnersPipeline: PipelineStage[] = [
      {
        $match: {
          deletedAt: null,
          $or: [
            { value: { $regex: regex } },
            ...(searchNum ? [{ id: searchNum }] : []),
            ...(userIds.length ? [{ usedById: { $in: userIds } }] : []),
          ],
        },
      },
      ...(userIds.length
        ? [
            {
              $lookup: {
                from: COLLECTIONS.users,
                let: { userId: '$usedById' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$_id', '$$userId'] },
                      deletedAt: null,
                      role: { $nin: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
                      $or: [
                        { firstName: { $regex: regex } },
                        { lastName: { $regex: regex } },
                        { phoneNumber: { $regex: regex } },
                        { tgFirstName: { $regex: regex } },
                        { tgLastName: { $regex: regex } },
                      ],
                    },
                  },
                ],
                as: 'matchedUsers',
              },
            },
            {
              $match: {
                $or: [
                  { value: { $regex: regex } },
                  ...(searchNum ? [{ id: searchNum }] : []),
                  { 'matchedUsers.0': { $exists: true } },
                ],
              },
            },
          ]
        : []),
      this.lookupUserStage('usedById'),
      this.lookupGiftStage('giftId'),
      this.flattenLookupStage(),
      this.usedAtStage(),
      this.derivedFieldsStage(),
      {
        $match: {
          $or: [
            { value: { $regex: regex } },
            ...(searchNum ? [{ idString: searchTerm }] : []),
            { usedByFullName: { $regex: regex } },
            { usedByPhone: { $regex: regex } },
          ],
        },
      },
    ];

    // Parallel aggregate qilish
    const [codesResult, winnersResult] = await Promise.all([
      this.codeModel.aggregate([{ $facet: { data: codesPipeline as any[] } }]).exec(),
      this.winnerModel.aggregate([{ $facet: { data: winnersPipeline as any[] } }]).exec(),
    ]);

    const codesData = codesResult[0]?.data || [];
    const winnersData = winnersResult[0]?.data || [];

    // Birlashtirish va sort qilish
    const allResults = [
      ...codesData.map((r: any) => ({ ...r, _source: 'code' })),
      ...winnersData.map((r: any) => ({ ...r, _source: 'winner' })),
    ].sort((a: any, b: any) => {
      // usedAtDate bo'yicha sort (eng yangilari birinchi)
      const aDate = a.usedAtDate ? new Date(a.usedAtDate).getTime() : 0;
      const bDate = b.usedAtDate ? new Date(b.usedAtDate).getTime() : 0;
      return bDate - aDate;
    });

    // Pagination
    const total = allResults.length;
    const startIndex = (query.page - 1) * query.limit;
    const paginatedResults = allResults.slice(startIndex, startIndex + query.limit);

    return {
      data: paginatedResults.map((record: any) => this.transformRecord(record)),
      total,
    };
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

private async aggregateGiftReceivers(query: DashboardGiftCodesDto) {
  const baseFilter: Record<string, any> = {
    deletedAt: null,
    isUsed: true,
    usedAt: { $ne: null },
    giftId: { $ne: null },
  };

  if ('giftId' in query && query.giftId) {
    baseFilter.giftId = new Types.ObjectId(String(query.giftId));
  }

    const pipeline: PipelineStage[] = [
      { $match: baseFilter },
      this.lookupUserStage(),
      this.lookupGiftStage(),
      this.flattenLookupStage(),
      this.usedAtStage(),
      this.derivedFieldsStage(),
    ];

    // Gift names filter
    if ('giftNames' in query && Array.isArray(query.giftNames) && query.giftNames.length) {
      pipeline.push({
        $match: {
          $or: query.giftNames.map((name: string) => ({
            giftName: { $regex: new RegExp(this.escapeRegex(name), 'i') },
          })),
        },
      });
    }

    // Search filter
    const searchStage = this.buildSearchStage(query.search);
    if (searchStage) {
      pipeline.push(searchStage);
    }

    // Parallel queries from both collections (faqat sovg'a olganlar)
    const [codesResult, winnersResult] = await Promise.all([
      this.codeModel.aggregate([
        {
          $facet: {
            data: [...pipeline as any[], { $sort: { usedAtDate: -1, id: 1 } }],
            total: [...pipeline as any[], { $count: 'total' }],
          },
        },
      ]).exec(),
      this.winnerModel.aggregate([
        {
          $facet: {
            data: [...pipeline as any[], { $sort: { usedAtDate: -1, id: 1 } }],
            total: [...pipeline as any[], { $count: 'total' }],
          },
        },
      ]).exec(),
    ]);

    const codesData = codesResult[0]?.data || [];
    const winnersData = winnersResult[0]?.data || [];
    const codesTotal = codesResult[0]?.total?.[0]?.total || 0;
    const winnersTotal = winnersResult[0]?.total?.[0]?.total || 0;

    // Combine and sort all results (faqat sovg'a olganlar)
    const allResults = [
      ...codesData.map((r: any) => ({ ...r, _source: 'code' })),
      ...winnersData.map((r: any) => ({ ...r, _source: 'winner' })),
    ].sort((a: any, b: any) => {
      // Sort by usedAtDate (newest first), then by id
      const aDate = a.usedAtDate ? new Date(a.usedAtDate).getTime() : 0;
      const bDate = b.usedAtDate ? new Date(b.usedAtDate).getTime() : 0;
      if (bDate !== aDate) return bDate - aDate;
      return (a.id || 0) - (b.id || 0);
    });

    // Pagination
    const total = codesTotal + winnersTotal;
    const startIndex = (query.page - 1) * query.limit;
    const paginatedResults = allResults.slice(startIndex, startIndex + query.limit);

    return {
      data: paginatedResults.map((record: any) => this.transformRecord(record)),
      total,
    };
  }

  // Ikkala collection'dan ham ma'lumot olish
  private async aggregateFromBothCollections(query: DashboardCodesDto | DashboardGiftCodesDto) {
    const baseFilter = this.buildBaseFilter();

    if ('giftId' in query && query.giftId) {
      baseFilter['giftId'] = new Types.ObjectId(query.giftId);
    }

    const pipeline: PipelineStage[] = [
      { $match: baseFilter },
      this.lookupUserStage(),
      this.lookupGiftStage(),
      this.flattenLookupStage(),
      this.usedAtStage(),
      this.derivedFieldsStage(),
    ];

    // Gift names filter
    if ('giftNames' in query && Array.isArray(query.giftNames) && query.giftNames.length) {
      pipeline.push({
        $match: {
          $or: query.giftNames.map((name: string) => ({
            giftName: { $regex: new RegExp(this.escapeRegex(name), 'i') },
          })),
        },
      });
    }

    // Search filter
    const searchStage = this.buildSearchStage(query.search);
    if (searchStage) {
      pipeline.push(searchStage);
    }

    // Parallel queries from both collections
    const [codesResult, winnersResult] = await Promise.all([
      this.codeModel.aggregate([
        {
          $facet: {
            data: [...pipeline as any[], { $sort: { usedAtDate: -1, id: 1 } }],
            total: [...pipeline as any[], { $count: 'total' }],
          },
        },
      ]).exec(),
      this.winnerModel.aggregate([
        {
          $facet: {
            data: [...pipeline as any[], { $sort: { usedAtDate: -1, id: 1 } }],
            total: [...pipeline as any[], { $count: 'total' }],
          },
        },
      ]).exec(),
    ]);

    const codesData = codesResult[0]?.data || [];
    const winnersData = winnersResult[0]?.data || [];
    const codesTotal = codesResult[0]?.total?.[0]?.total || 0;
    const winnersTotal = winnersResult[0]?.total?.[0]?.total || 0;

    // Combine and sort all results
    const allResults = [
      ...codesData.map((r: any) => ({ ...r, _source: 'code' })),
      ...winnersData.map((r: any) => ({ ...r, _source: 'winner' })),
    ].sort((a: any, b: any) => {
      // Sort by usedAtDate (newest first), then by id
      const aDate = a.usedAtDate ? new Date(a.usedAtDate).getTime() : 0;
      const bDate = b.usedAtDate ? new Date(b.usedAtDate).getTime() : 0;
      if (bDate !== aDate) return bDate - aDate;
      return (a.id || 0) - (b.id || 0);
    });

    // Pagination
    const total = codesTotal + winnersTotal;
    const startIndex = (query.page - 1) * query.limit;
    const paginatedResults = allResults.slice(startIndex, startIndex + query.limit);

    return {
      data: paginatedResults.map((record: any) => this.transformRecord(record)),
      total,
    };
  }
}


