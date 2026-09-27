const express = require('express');
const router = express.Router();
const { getLink, postLink } = require('../controllers/actLinkController');

// No sign-in: each link carries a signed token for one action on one order.
router.get('/:token', getLink);
router.post('/:token', postLink);

module.exports = router;
