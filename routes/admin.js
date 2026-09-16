const express = require("express");
const adminController = require("../controllers/adminController");
const upload = require("../config/multer");
const router = express.Router();

router.get("/dashboard", adminController.dashboard); // done
router.get("/allCustomers", adminController.getAllCustomers); // done
router.post("/uploadExcel", upload.single("file"), adminController.uploadExcel); // done
router.post('/updateCustomerProfile', adminController.updateCustomerProfile); // new
router.post("/dealsManager", adminController.dealsManager); // done
router.get("/getAllDeals", adminController.getAllDeals);
router.get("/getDealDetails/:dealId", adminController.getDealDetails);
router.post("/createTemplate", adminController.createTemplate);
router.get("/getTemplateById/:templateId", adminController.getTemplateById);
router.get("/getTemplateByName/:templateName", adminController.getTemplateByName);
router.post("/sendEmail", adminController.sendEmail);
router.get("/getDealHistory/:dealId", adminController.getDealHistory);
router.get("/getEmailHistory", adminController.getEmailHistory);
router.get("/getCustomerProfile/:customerUserId", adminController.clientProfile);
router.get("/getAllTemplates", adminController.getAllTemplates);
router.put("/updateTemplate/:templateId", adminController.updateTemplate);
router.delete("/deleteTemplate/:templateId", adminController.deleteTemplate);
router.get('/getProfile', adminController.getProfile); // done
router.post('/updateProfile', adminController.updateProfile); // done
router.delete('/deleteCustomer/:customerId', adminController.deleteCustomer); // new
router.post('/campaigns', adminController.createCampaign);
router.get('/campaigns/preview-count', adminController.previewAudienceCount);
router.get('/campaigns/preview', adminController.previewAudienceList);
router.get('/campaigns', adminController.getCampaigns);
router.get('/campaignAudience', adminController.getCampaignAudience);
router.get('/campaignAudience/:userId', adminController.getAudienceMemberDetail);
router.delete('/campaignAudience/:userId', adminController.deleteAudienceMember);
router.get('/campaigns/:id', adminController.getCampaignById);
router.delete('/campaigns/:id', adminController.deleteCampaign);
router.get('/operationsDashboard', adminController.getOperationsDashboard);
router.get('/insightsDashboard', adminController.getInsightsDashboard);
router.get('/activityLogs', adminController.getActivityLogs);

module.exports = router;
