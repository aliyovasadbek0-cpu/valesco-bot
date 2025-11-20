import { PipelineStage } from 'mongoose';
import { DashboardClientPagingDto } from './class-validator';
import { UserModel } from '../../../db/models/users.model';
import { COLLECTIONS } from '../../../common/constant/tables';

export class DashboardClientService {
  constructor(private readonly userModel = UserModel) {}

  async getClients(query: DashboardClientPagingDto) {
    query.limit = query.limit ?? 10;
    query.page = query.page ?? 1;

    const baseMatch: PipelineStage.Match['$match'] = { deletedAt: null };

    if (query.firstName) {
      baseMatch['firstName'] = { $regex: new RegExp(query.firstName, 'i') };
    }
    if (query.lastName) {
      baseMatch['lastName'] = { $regex: new RegExp(query.lastName, 'i') };
    }
    if (query.phoneNumber) {
      baseMatch['phoneNumber'] = { $regex: new RegExp(query.phoneNumber, 'i') };
    }

    if (query.registeredFrom || query.registeredTo) {
      baseMatch['createdAt'] = {};
      if (query.registeredFrom) {
        baseMatch['createdAt']['$gte'] = new Date(query.registeredFrom);
      }
      if (query.registeredTo) {
        const to = new Date(query.registeredTo);
        to.setUTCHours(23, 59, 59, 999);
        baseMatch['createdAt']['$lte'] = to;
      }
    }

    const searchRegex = query.search ? new RegExp(query.search, 'i') : null;

    const $lookupUsedCodes: PipelineStage.Lookup = {
      $lookup: {
        from: COLLECTIONS.codes,
        let: { userId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$usedById', '$$userId'] },
              deletedAt: null,
              isUsed: true,
              usedAt: { $ne: null },
            },
          },
          {
            $project: {
              giftId: 1,
            },
          },
        ],
        as: 'usedCodes',
      },
    };

    const $addFields: PipelineStage.AddFields = {
      $addFields: {
        giftsCount: {
          $size: {
            $filter: {
              input: '$usedCodes',
              as: 'code',
              cond: { $ne: ['$$code.giftId', null] },
            },
          },
        },
        displayFirstName: {
          $ifNull: ['$firstName', '$tgFirstName'],
        },
        displayLastName: {
          $ifNull: ['$lastName', '$tgLastName'],
        },
      },
    };

    const pipeline: PipelineStage.FacetPipelineStage[] = [{ $match: baseMatch }, $lookupUsedCodes, $addFields];

    const giftCountRange: Record<string, number> = {};
    if (typeof query.minGifts === 'number') {
      giftCountRange['$gte'] = query.minGifts;
    }
    if (typeof query.maxGifts === 'number') {
      giftCountRange['$lte'] = query.maxGifts;
    }
    if (Object.keys(giftCountRange).length) {
      pipeline.push({ $match: { giftsCount: giftCountRange } });
    }

    if (searchRegex) {
      pipeline.push({
        $match: {
          $or: [
            { displayFirstName: { $regex: searchRegex } },
            { displayLastName: { $regex: searchRegex } },
            { phoneNumber: { $regex: searchRegex } },
          ],
        },
      });
    }

    const $project: PipelineStage.Project = {
      $project: {
        _id: 1,
        firstName: '$displayFirstName',
        lastName: '$displayLastName',
        phoneNumber: 1,
        giftsCount: 1,
        createdAt: 1,
      },
    };

    const $sort: PipelineStage.Sort = { $sort: { createdAt: -1 } };
    const $skip: PipelineStage.Skip = { $skip: (query.page - 1) * query.limit };
    const $limit: PipelineStage.Limit = { $limit: query.limit };

    const result = await this.userModel.aggregate<{
      data: any[];
      total: [{ total: number }];
    }>([
      {
        $facet: {
          data: [...pipeline, $project, $sort, $skip, $limit],
          total: [...pipeline, { $count: 'total' }],
        },
      },
    ]);

    const data = result[0]?.data ?? [];
    const total = result[0]?.total?.[0]?.total ?? 0;

    return {
      data,
      total,
    };
  }
}

