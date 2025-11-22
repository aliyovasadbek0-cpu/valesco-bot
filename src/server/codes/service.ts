import { PipelineStage } from 'mongoose';
import { PagingDto } from '../../common/validation/dto/paging.dto';
import { Code, CodeModel } from '../../db/models/codes.model';
import { BaseService } from '../base.service';
import { CodeDto, CodePagingDto } from './class-validator';
import { COLLECTIONS } from '../../common/constant/tables';
import { CodeException } from './error';
import { GiftModel } from '../../db/models/gifts.model';
import { QuerySort } from '../../common/validation/types';
import { isMongoId } from 'class-validator';
import { WinnerModel } from '../../db/models/winners.model';

type GiftTier = 'premium' | 'standard' | 'economy' | 'symbolic';

// Bazadan g'olib kodlarni olish (WinnerModel dan)
const norm = (s: string) => (s || '').trim().toUpperCase().replace(/-/g, '');

export class CodeService extends BaseService<Code, CodeDto> {
  constructor(
    model: typeof CodeModel = CodeModel,
    private readonly giftModel: typeof GiftModel = GiftModel,
    private readonly winnerModel: typeof WinnerModel = WinnerModel,
  ) {
    super(model);
  }

  async codeGiftGive(codeId: string, giftGivenBy: string) {
    return await this.model.findByIdAndUpdate(
      this.toObjectId(codeId),
      {
        giftGivenBy: giftGivenBy,
        giftGivenAt: new Date().toISOString(),
      },
      { lean: true, new: true, projection: { month: 0 } },
    );
  }

  async getPaging(query: CodePagingDto): Promise<{ data: CodeDto[]; total: number; totalUsedCount: number }> {
    const filter = { deletedAt: null };

    if (query.isUsed == true || query.isUsed == false) {
      filter['usedAt'] = query.isUsed ? { $ne: null } : null;
    }

    if (query.search) {
      filter['$or'] = [{ value: query.search }, { id: query.search }];
    }

    if (query.giftId) {
      if (query.giftId === 'withGift') {
        filter['giftId'] = { $ne: null };
      } else if (isMongoId(query.giftId)) {
        filter['giftId'] = this.toObjectId(query.giftId);
      }
    }

    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;
    const $match: PipelineStage.Match = { $match: filter };
    const $project = {
      $project: {
        _id: 1,
        id: 1,
        value: 1,
        giftId: 1,
        isUsed: 1,
        usedAt: 1,
        usedById: 1,
      },
    };
    const $sort: PipelineStage.Sort = { $sort: { usedAt: -1, id: 1 } };
    const $limit = { $limit: query.limit };
    const $skip = { $skip: (query.page - 1) * query.limit };
    const $lookupUser: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.users,
        let: { usedById: '$usedById' },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ['$_id', '$$usedById'],
              },
            },
          },
          {
            $project: {
              _id: 1,
              tgId: 1,
              tgFirstName: 1,
              tgLastName: 1,
              firstName: 1,
              phoneNumber: 1,
            },
          },
        ],
        as: 'usedBy',
      },
    };
    const $lookupGift: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.gifts,
        let: { giftId: '$giftId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ['$_id', '$$giftId'],
              },
            },
          },
          {
            $project: {
              _id: 1,
              id: 1,
              name: 1,
              image: 1,
              images: 1,
              totalCount: 1,
              usedCount: 1,
            },
          },
        ],
        as: 'gift',
      },
    };

    const $lastProject: PipelineStage.Project = {
      $project: {
        usedBy: { $arrayElemAt: ['$usedBy', 0] },
        gift: { $arrayElemAt: ['$gift', 0] },
        ...$project.$project,
      },
    };
    const pipeline: PipelineStage.FacetPipelineStage[] = [
      $match,
      $project,
      $sort,
      $skip,
      $limit,
      $lookupUser,
      $lookupGift,
      $lastProject,
    ];

    const res = await this.model.aggregate<{
      data: CodeDto[];
      total: [{ total: number }];
      totalUsedCount: [{ total: number }];
    }>([
      {
        $facet: {
          data: pipeline,
          total: [$match, { $count: 'total' }],
          totalUsedCount: [
            { $match: { deletedAt: null, isUsed: true, usedAt: { $ne: null } } },
            { $count: 'total' },
          ],
        },
      },
    ]);

    return {
      data: res[0].data,
      total: res[0].total[0] && res[0].total[0].total ? res[0].total[0].total : 0,
      totalUsedCount: res[0].total[0] && res[0].totalUsedCount[0].total ? res[0].totalUsedCount[0].total : 0,
    };
  }

  async getUsedByUserPaging(query: PagingDto, usedById: string): Promise<{ data: CodeDto[]; total: number }> {
    const filter = {
      deletedAt: null,
      usedById: this.toObjectId(usedById),
    };
    if (query.search) {
      filter['$or'] = [{ value: { $regex: query.search } }, { id: Number(query.search) }];
    }

    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const $match = { $match: filter };
    const $project = {
      $project: {
        _id: 1,
        id: 1,
        value: 1,
        giftId: 1,
        isUsed: 1,
        usedAt: 1,
        usedById: 1,
      },
    };
    const orderType = query.orderType === 'ASC' ? 1 : -1;
    const sort: QuerySort<CodeDto> = query.orderBy ? { [query.orderBy]: orderType } : { id: 1 };

    const $sort: PipelineStage.Sort = { $sort: sort };
    const $limit = { $limit: query.limit };
    const $skip = { $skip: (query.page - 1) * query.limit };

    const $lookupGift: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.gifts,
        let: { giftId: '$giftId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ['$_id', '$$giftId'],
              },
            },
          },
          {
            $project: {
              _id: 1,
              id: 1,
              name: 1,
              image: 1,
              images: 1,
              type: 1,
              totalCount: 1,
              usedCount: 1,
            },
          },
        ],
        as: 'gift',
      },
    };

    const $lastProject: PipelineStage.Project = {
      $project: {
        gift: { $arrayElemAt: ['$gift', 0] },
        ...$project.$project,
      },
    };
    const pipeline: PipelineStage.FacetPipelineStage[] = [
      $match,
      $project,
      $sort,
      $skip,
      $limit,
      $lookupGift,
      $lastProject,
    ];

    const res = await this.model.aggregate<{ data: CodeDto[]; total: [{ total: number }] }>([
      {
        $facet: {
          data: pipeline,
          total: [$match, { $count: 'total' }],
        },
      },
    ]);

    return {
      data: res[0].data,
      total: res[0].total[0] && res[0].total[0].total ? res[0].total[0].total : 0,
    };
  }

  async checkCode(value: string) {
    const code = await this.findOne({ value: value, deletedAt: null }, { value: 1, giftId: 1 });
    if (!code) {
      throw CodeException.NotFound();
    }

    if (!code.giftId) {
      return {
        value: code.value,
        gift: null,
      };
    }

    const gift = await this.giftModel
      .findOne({ _id: code.giftId, deletedAt: null }, { name: 1, image: 1, images: 1 })
      .lean();
    if (!gift) {
      return {
        value: code.value,
        gift: null,
      };
    }

    return {
      value: code.value,
      gift: gift,
    };
  }

  // G'oliblar - WinnerModel dagi kodlar bilan ishlatilgan kodlar
  async getWinners(query: PagingDto): Promise<{ data: any[]; total: number }> {
    // Bazadan barcha g'olib kodlarni olamiz
    const allWinners = await WinnerModel.find({ deletedAt: null }).select('value').lean();
    const winnerValues = allWinners.map(w => w.value);
    
    const winnerValueFilters: any[] = [];
    
    for (const code of winnerValues) {
      const normalized = norm(code);
      const withHyphen = normalized.length === 10 ? `${normalized.slice(0, 6)}-${normalized.slice(6)}` : normalized;
      winnerValueFilters.push(
        { value: code },
        { value: withHyphen },
        { value: normalized },
        { value: code.replace(/-/g, '') },
      );
    }

    const filter: any = {
      deletedAt: null,
      isUsed: true,
      $or: winnerValueFilters.length > 0 ? winnerValueFilters : [{ value: null }], // Agar g'olib kodlar bo'lmasa
    };

    if (query.search) {
      filter['$and'] = [
        { $or: winnerValueFilters },
        { value: { $regex: query.search, $options: 'i' } },
      ];
      delete filter['$or'];
    }

    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const $match = { $match: filter };
    const $lookupUser: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.users,
        let: { usedById: '$usedById' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$usedById'] } } },
          { $project: { _id: 1, tgId: 1, tgFirstName: 1, tgLastName: 1, firstName: 1, phoneNumber: 1 } },
        ],
        as: 'usedBy',
      },
    };
    const $lookupGift: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.gifts,
        let: { giftId: '$giftId' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$giftId'] } } },
          { $project: { _id: 1, id: 1, name: 1, type: 1, image: 1, images: 1 } },
        ],
        as: 'gift',
      },
    };
    const $project: PipelineStage.Project = {
      $project: {
        _id: 1,
        id: 1,
        value: 1,
        isUsed: 1,
        usedAt: 1,
        usedById: 1,
        giftId: 1,
        usedBy: { $arrayElemAt: ['$usedBy', 0] },
        gift: { $arrayElemAt: ['$gift', 0] },
      },
    };
    const $sort: PipelineStage.Sort = { $sort: { usedAt: -1 } };
    const $skip = { $skip: (query.page - 1) * query.limit };
    const $limit = { $limit: query.limit };

    const res = await this.model.aggregate([
      { $facet: {
        data: [$match, $lookupUser, $lookupGift, $project, $sort, $skip, $limit],
        total: [$match, { $count: 'total' }],
      }},
    ]);

    return {
      data: res[0].data,
      total: res[0].total[0]?.total || 0,
    };
  }

  // Mag'lublar - WinnerModel da yo'q, lekin CodeModel da bor va ishlatilgan kodlar
  async getLosers(query: PagingDto): Promise<{ data: any[]; total: number }> {
    // Bazadan barcha g'olib kodlarni olamiz
    const allWinners = await WinnerModel.find({ deletedAt: null }).select('value').lean();
    const winnerValues = allWinners.map(w => w.value);
    
    const winnerValueFilters: any[] = [];
    
    for (const code of winnerValues) {
      const normalized = norm(code);
      const withHyphen = normalized.length === 10 ? `${normalized.slice(0, 6)}-${normalized.slice(6)}` : normalized;
      winnerValueFilters.push(
        { value: code },
        { value: withHyphen },
        { value: normalized },
        { value: code.replace(/-/g, '') },
      );
    }

    const filter: any = {
      deletedAt: null,
      isUsed: true,
      $nor: winnerValueFilters.length > 0 ? [{ $or: winnerValueFilters }] : [{ value: null }],
    };

    if (query.search) {
      filter['$and'] = [
        { $nor: [{ $or: winnerValueFilters }] },
        { value: { $regex: query.search, $options: 'i' } },
      ];
      delete filter['$nor'];
    }

    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const $match = { $match: filter };
    const $lookupUser: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.users,
        let: { usedById: '$usedById' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$usedById'] } } },
          { $project: { _id: 1, tgId: 1, tgFirstName: 1, tgLastName: 1, firstName: 1, phoneNumber: 1 } },
        ],
        as: 'usedBy',
      },
    };
    const $project: PipelineStage.Project = {
      $project: {
        _id: 1,
        id: 1,
        value: 1,
        isUsed: 1,
        usedAt: 1,
        usedById: 1,
        usedBy: { $arrayElemAt: ['$usedBy', 0] },
      },
    };
    const $sort: PipelineStage.Sort = { $sort: { usedAt: -1 } };
    const $skip = { $skip: (query.page - 1) * query.limit };
    const $limit = { $limit: query.limit };

    const res = await this.model.aggregate([
      { $facet: {
        data: [$match, $lookupUser, $project, $sort, $skip, $limit],
        total: [$match, { $count: 'total' }],
      }},
    ]);

    return {
      data: res[0].data,
      total: res[0].total[0]?.total || 0,
    };
  }

  // Winner kodlar - WinnerModel dagi kodlar (bazada bor)
  async getWinnerCodes(query: PagingDto): Promise<{ data: any[]; total: number }> {
    // Bazadan barcha g'olib kodlarni olamiz
    const allWinners = await WinnerModel.find({ deletedAt: null }).select('value').lean();
    const winnerValues = allWinners.map(w => w.value);
    
    const winnerValueFilters: any[] = [];
    
    for (const code of winnerValues) {
      const normalized = norm(code);
      const withHyphen = normalized.length === 10 ? `${normalized.slice(0, 6)}-${normalized.slice(6)}` : normalized;
      winnerValueFilters.push(
        { value: code },
        { value: withHyphen },
        { value: normalized },
        { value: code.replace(/-/g, '') },
      );
    }

    const filter: any = {
      deletedAt: null,
      $or: winnerValueFilters.length > 0 ? winnerValueFilters : [{ value: null }], // Agar g'olib kodlar bo'lmasa
    };

    if (query.search) {
      filter['$and'] = [
        { $or: winnerValueFilters },
        { value: { $regex: query.search, $options: 'i' } },
      ];
      delete filter['$or'];
    }

    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const $match = { $match: filter };
    const $lookupGift: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.gifts,
        let: { giftId: '$giftId' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$giftId'] } } },
          { $project: { _id: 1, id: 1, name: 1, type: 1, image: 1, images: 1 } },
        ],
        as: 'gift',
      },
    };
    const $lookupUser: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.users,
        let: { usedById: '$usedById' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$usedById'] } } },
          { $project: { _id: 1, tgId: 1, tgFirstName: 1, tgLastName: 1, firstName: 1, phoneNumber: 1 } },
        ],
        as: 'usedBy',
      },
    };
    const $project: PipelineStage.Project = {
      $project: {
        _id: 1,
        id: 1,
        value: 1,
        isUsed: 1,
        usedAt: 1,
        usedById: 1,
        giftId: 1,
        gift: { $arrayElemAt: ['$gift', 0] },
        usedBy: { $arrayElemAt: ['$usedBy', 0] },
      },
    };
    const $sort: PipelineStage.Sort = { $sort: { id: 1 } };
    const $skip = { $skip: (query.page - 1) * query.limit };
    const $limit = { $limit: query.limit };

    const res = await this.model.aggregate([
      { $facet: {
        data: [$match, $lookupGift, $lookupUser, $project, $sort, $skip, $limit],
        total: [$match, { $count: 'total' }],
      }},
    ]);

    return {
      data: res[0].data,
      total: res[0].total[0]?.total || 0,
    };
  }

  // Yutuqsiz kodlar - bazada bor, lekin WinnerModel da yo'q kodlar
  async getNonWinnerCodes(query: PagingDto): Promise<{ data: any[]; total: number }> {
    // Bazadan barcha g'olib kodlarni olamiz
    const allWinners = await WinnerModel.find({ deletedAt: null }).select('value').lean();
    const winnerValues = allWinners.map(w => w.value);
    
    const winnerValueFilters: any[] = [];
    
    for (const code of winnerValues) {
      const normalized = norm(code);
      const withHyphen = normalized.length === 10 ? `${normalized.slice(0, 6)}-${normalized.slice(6)}` : normalized;
      winnerValueFilters.push(
        { value: code },
        { value: withHyphen },
        { value: normalized },
        { value: code.replace(/-/g, '') },
      );
    }

    const filter: any = {
      deletedAt: null,
      $nor: winnerValueFilters.length > 0 ? [{ $or: winnerValueFilters }] : [{ value: null }],
    };

    if (query.search) {
      filter['$and'] = [
        { $nor: [{ $or: winnerValueFilters }] },
        { value: { $regex: query.search, $options: 'i' } },
      ];
      delete filter['$nor'];
    }

    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const $match = { $match: filter };
    const $lookupUser: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.users,
        let: { usedById: '$usedById' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$usedById'] } } },
          { $project: { _id: 1, tgId: 1, tgFirstName: 1, tgLastName: 1, firstName: 1, phoneNumber: 1 } },
        ],
        as: 'usedBy',
      },
    };
    const $project: PipelineStage.Project = {
      $project: {
        _id: 1,
        id: 1,
        value: 1,
        isUsed: 1,
        usedAt: 1,
        usedById: 1,
        giftId: 1,
        usedBy: { $arrayElemAt: ['$usedBy', 0] },
      },
    };
    const $sort: PipelineStage.Sort = { $sort: { id: 1 } };
    const $skip = { $skip: (query.page - 1) * query.limit };
    const $limit = { $limit: query.limit };

    const res = await this.model.aggregate([
      { $facet: {
        data: [$match, $lookupUser, $project, $sort, $skip, $limit],
        total: [$match, { $count: 'total' }],
      }},
    ]);

    return {
      data: res[0].data,
      total: res[0].total[0]?.total || 0,
    };
  }

  // Kod kiritib GET qilganda qaysi oyga tegishli ekanligini qaytaradi
  async getCodeMonth(value: string): Promise<{ value: string; month: string | null }> {
    const normalized = norm(value);
    const withHyphen = normalized.length === 10 ? `${normalized.slice(0, 6)}-${normalized.slice(6)}` : normalized;
    
    const code = await this.model.findOne({
      deletedAt: null,
      $or: [
        { value: value },
        { value: withHyphen },
        { value: normalized },
        { value: value.replace(/-/g, '') },
      ],
    }, { value: 1, month: 1 }).lean();

    if (!code) {
      throw CodeException.NotFound();
    }

    return {
      value: code.value,
      month: code.month || null,
    };
  }

  // Oy tanlansa shu oyga tegishli kodlar chiqadi
  async getCodesByMonth(query: PagingDto, month: string): Promise<{ data: any[]; total: number }> {
    const filter: any = {
      deletedAt: null,
      month: month,
    };

    if (query.search) {
      filter['$or'] = [{ value: { $regex: query.search, $options: 'i' } }, { id: Number(query.search) }];
    }

    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const $match = { $match: filter };
    const $project = {
      $project: {
        _id: 1,
        id: 1,
        value: 1,
        giftId: 1,
        isUsed: 1,
        usedAt: 1,
        usedById: 1,
        month: 1,
      },
    };
    const $sort: PipelineStage.Sort = { $sort: { usedAt: -1, id: 1 } };
    const $limit = { $limit: query.limit };
    const $skip = { $skip: (query.page - 1) * query.limit };
    const $lookupUser: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.users,
        let: { usedById: '$usedById' },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ['$_id', '$$usedById'],
              },
            },
          },
          {
            $project: {
              _id: 1,
              tgId: 1,
              tgFirstName: 1,
              tgLastName: 1,
              firstName: 1,
              phoneNumber: 1,
            },
          },
        ],
        as: 'usedBy',
      },
    };
    const $lookupGift: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.gifts,
        let: { giftId: '$giftId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ['$_id', '$$giftId'],
              },
            },
          },
          {
            $project: {
              _id: 1,
              id: 1,
              name: 1,
              image: 1,
              images: 1,
              totalCount: 1,
              usedCount: 1,
            },
          },
        ],
        as: 'gift',
      },
    };

    const $lastProject: PipelineStage.Project = {
      $project: {
        usedBy: { $arrayElemAt: ['$usedBy', 0] },
        gift: { $arrayElemAt: ['$gift', 0] },
        ...$project.$project,
      },
    };
    const pipeline: PipelineStage.FacetPipelineStage[] = [
      $match,
      $project,
      $sort,
      $skip,
      $limit,
      $lookupUser,
      $lookupGift,
      $lastProject,
    ];

    const res = await this.model.aggregate<{
      data: any[];
      total: [{ total: number }];
    }>([
      {
        $facet: {
          data: pipeline,
          total: [$match, { $count: 'total' }],
        },
      },
    ]);

    return {
      data: res[0].data,
      total: res[0].total[0] && res[0].total[0].total ? res[0].total[0].total : 0,
    };
  }
}
