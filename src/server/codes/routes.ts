import { Router } from 'express';
import { runAsyncWrapper } from '../../common/utility/run-async-wrapper';
import { codesController } from './controller';

const codesRouter = Router()
  // Barcha kodlar
  .get('/', runAsyncWrapper(codesController.getAll))
  .get('/usedByUser/:usedById', runAsyncWrapper(codesController.getUsedBy))
  .patch('/gift-give/:_id', runAsyncWrapper(codesController.codeGiftGive))
  // G'oliblar (winners.json dagi kodlar bilan ishlatilgan)
  .get('/winners/all', runAsyncWrapper(codesController.getWinners))
  .get('/winners/:id', runAsyncWrapper(codesController.getWinnerById))
  // Mag'lublar (winners.json da yo'q, lekin ishlatilgan)
  .get('/losers/all', runAsyncWrapper(codesController.getLosers))
  .get('/losers/:id', runAsyncWrapper(codesController.getLoserById))
  // Winner kodlar (winners.json dagi kodlar)
  .get('/winner-codes/all', runAsyncWrapper(codesController.getWinnerCodes))
  .get('/winner-codes/:id', runAsyncWrapper(codesController.getWinnerCodeById))
  // Yutuqsiz kodlar (bazada bor, lekin winners.json da yo'q)
  .get('/non-winner-codes/all', runAsyncWrapper(codesController.getNonWinnerCodes))
  .get('/non-winner-codes/:id', runAsyncWrapper(codesController.getNonWinnerCodeById))
  // Oxirgi route - barcha boshqa routelardan keyin
  .get('/:id', runAsyncWrapper(codesController.getById));

export { codesRouter };
