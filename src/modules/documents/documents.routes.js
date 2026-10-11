import { Router } from 'express';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { pageQuery } from '../../common/utils/schemas.js';
import { requireGovernance } from '../committee/committee.access.js';
import * as controller from './documents.controller.js';
import * as s from './documents.validation.js';

// Every member browses the library; each document's visibility decides who sees it (service).
// The committee uploads and curates.
const router = Router();
router.use(authenticate, requireSociety);
const gov = requireGovernance;

router.get('/folders', controller.listFolders);
router.post('/folders', gov, validate({ body: s.folder }), controller.createFolder);
router.patch('/folders/:id', gov, validate({ params: s.idParams, body: s.folder }), controller.renameFolder);
router.delete('/folders/:id', gov, validate({ params: s.idParams }), controller.removeFolder);

router.get('/', validate({ query: s.listDocuments }), controller.list);
router.post('/', gov, validate({ body: s.createDocument }), controller.create);
router.get('/tags', controller.tags);
router.get('/:id', validate({ params: s.idParams }), controller.getById);
router.patch('/:id', gov, validate({ params: s.idParams, body: s.updateDocument }), controller.update);
router.post('/:id/versions', gov, validate({ params: s.idParams, body: s.addVersion }), controller.addVersion);
router.post('/:id/archive', gov, validate({ params: s.idParams }), controller.archive);
router.post('/:id/restore', gov, validate({ params: s.idParams }), controller.restore);
router.get('/:id/download', validate({ params: s.idParams, query: s.downloadQuery }), controller.download);
router.get('/:id/downloads', gov, validate({ params: s.idParams, query: pageQuery }), controller.downloads);

export default router;
