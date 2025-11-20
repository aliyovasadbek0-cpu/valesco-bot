import { PipelineStage, Types } from 'mongoose';
import { CodeModel } from '../../../db/models/codes.model';
import { DashboardGiftCodesDto, DashboardGiftCodeStatus } from '../gift-codes/class-validator';
import { DashboardCodesDto } from './class-validator';
import { COLLECTIONS } from '../../../common/constant/tables';

interface AggregateOptions {
  query: DashboardGiftCodesDto | DashboardCodesDto;
  baseFilter?: PipelineStage.Match['$match'];
  postLookupMatches?: PipelineStage[];
}

export class DashboardCodesService {
  constructor(private readonly codeModel = CodeModel) {}

  async getGiftCodes(query: DashboardGiftCodesDto) {
    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const baseFilter = this.buildBaseFilter();
    const status = query.status ?? DashboardGiftCodeStatus.ASSIGNED;

    if (status === DashboardGiftCodeStatus.ASSIGNED) {
      baseFilter['giftId'] = { $ne: null };
    } else if (status === DashboardGiftCodeStatus.UNASSIGNED) {
      baseFilter['giftId'] = null;
    }

    return this.aggregateCodes({
      query,
      baseFilter,
    });
  }

  async getCodes(query: DashboardCodesDto) {
    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const baseFilter = this.buildBaseFilter();

    if (query.giftId) {
      baseFilter['giftId'] = new Types.ObjectId(query.giftId);
    }

    const postLookupMatches: PipelineStage[] = [];

    if (query.giftNames?.length) {
      postLookupMatches.push({
        $match: {
          $or: query.giftNames.map((name) => ({
            giftName: { $regex: new RegExp(this.escapeRegex(name), 'i') },
          })),
        },
      });
    }

    return this.aggregateCodes({
      query,
      baseFilter,
      postLookupMatches,
    });
  }

  private buildBaseFilter(): PipelineStage.Match['$match'] {
    return {
      deletedAt: null,
      isUsed: true,
      usedAt: { $ne: null },
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
          data: [...pipeline, $sort, $skip, $limit],
          total: [...pipeline, { $count: 'total' }],
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

  private lookupUserStage(): PipelineStage.Lookup {
    return {
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
        as: 'usedBy',
      },
    };
  }

  private lookupGiftStage(): PipelineStage.Lookup {
    return {
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

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

