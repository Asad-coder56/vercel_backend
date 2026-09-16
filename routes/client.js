const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');

router.get('/dashboard', clientController.dashboard);    // done
router.post('/createDeal', clientController.createDeal);   //done
router.get('/getMyDebts', clientController.getMyDebts);   // newly added
router.put('/dealsManager', clientController.dealManager);    //done
router.get('/getMyDeals', clientController.getMyDeals);     //done
router.post('/fullPayment', clientController.fullPayment);   // Authorize.Net Accept Hosted
router.post('/initiateInstallmentPlan', clientController.initiateInstallmentPlan); // Authorize.Net installment
router.get('/paymentReturn', clientController.paymentReturn); // Post-payment redirect
router.get('/paymentStatus/:paymentHistoryId', clientController.getPaymentStatus); // Polling endpoint
router.get('/getLatestInstallment', clientController.getLatestInstallment);   // done
router.get('/getDealHistory/:dealId', clientController.getDealHistory);
router.get('/getPaymentHistory', clientController.getPaymentHistory);
router.post('/createInstallments', clientController.createInstallments);   // done
router.post('/payInstallment/:installmentId', clientController.payInstallment); //pending for stripe
router.get('/getProfile', clientController.getProfile); // done
router.post('/updateProfile', clientController.updateProfile); // done
router.get('/getInstallmentHistory/:debtId', clientController.getInstallmentHistory); // done
router.get('/getInstallmentHistory', clientController.getInstallmentHistoryAll);

module.exports = router;
