const User = require("./user");
const Debt = require("./debt");
const Customer = require("./customer");
const Installment = require("./installment");
const SystemEmail = require("./systemEmail");
const PaymentHistory = require("./paymentHistory");
const EmailTemplate = require("./emailTemplate");
const Deal = require("./deal");
const CardDetails = require("./cardDetails");
const PaymentWebhookEvent = require("./paymentWebhookEvent");
const Campaign = require("./campaign");
const sequelize = require("../config/db");

//  user and deals relationships
User.hasMany(Deal, { foreignKey: "customerUserId" });
Deal.belongsTo(User, { foreignKey: "customerUserId", onDelete: "CASCADE" });

//  user adn customer relationships
// This is the issue with the cascade deletion
User.hasOne(Customer, { foreignKey: "userId" });
Customer.belongsTo(User, { foreignKey: "userId", onDelete: "CASCADE" });

// user and system email relationships
User.hasMany(SystemEmail, { foreignKey: "userId" });
SystemEmail.belongsTo(User, { foreignKey: "userId", onDelete: "CASCADE" });

// user and payment history relationships
User.hasMany(PaymentHistory, { foreignKey: "userId" });
PaymentHistory.belongsTo(User, { foreignKey: "userId", onDelete: "CASCADE" });


// user and installment relationships
User.hasMany(Installment, { foreignKey: "userId" });
Installment.belongsTo(User, { foreignKey: "userId", onDelete: "CASCADE" });

// user and card details relationships
User.hasOne(CardDetails, { foreignKey: "userId" });
CardDetails.belongsTo(User, { foreignKey: "userId", onDelete: "CASCADE" });

// Deal and debt Relationships
Debt.hasOne(Deal, { foreignKey: "debtId" });
Deal.belongsTo(Debt, { foreignKey: "debtId", onDelete: "CASCADE" });

// Customer and debt Relationships
Customer.hasMany(Debt, { foreignKey: "customerId" });
Debt.belongsTo(Customer, { foreignKey: "customerId", onDelete: "CASCADE" });

// Debt and payment history Relationships
Debt.hasMany(PaymentHistory, { foreignKey: "debtId" });
PaymentHistory.belongsTo(Debt, { foreignKey: "debtId", onDelete: "CASCADE" });

// Debt and installment Relationships
Debt.hasMany(Installment, { foreignKey: "debtId" });
Installment.belongsTo(Debt, { foreignKey: "debtId", onDelete: "CASCADE" });

// Installment and payment history Relationships
Installment.hasMany(PaymentHistory, { foreignKey: "installmentId" });
PaymentHistory.belongsTo(Installment, { foreignKey: "installmentId", onDelete: "CASCADE" });

// EmailTemplate and SystemEmail Relationships
EmailTemplate.hasOne(SystemEmail, { foreignKey: "emailTemplateId" });
SystemEmail.belongsTo(EmailTemplate, { foreignKey: "emailTemplateId", onDelete: "CASCADE" });

// EmailTemplate and Campaign Relationships
EmailTemplate.hasMany(Campaign, { foreignKey: "templateId" });
Campaign.belongsTo(EmailTemplate, { foreignKey: "templateId", onDelete: "CASCADE" });

// Campaign and SystemEmail Relationships
Campaign.hasMany(SystemEmail, { foreignKey: "campaignId" });
SystemEmail.belongsTo(Campaign, { foreignKey: "campaignId", onDelete: "CASCADE" });


module.exports = {
    sequelize,
    User,
    Debt,
    Customer,
    Installment,
    SystemEmail,
    PaymentHistory,
    EmailTemplate,
    Deal,
    CardDetails,
    PaymentWebhookEvent,
    Campaign,
};
