const { DataTypes } = require("sequelize");
const Sequelize = require("../config/db");

const PaymentHistory = Sequelize.define("PaymentHistory", {
    sessionId: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    sessionUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    paymentType: {
        type: DataTypes.ENUM("full", "installment", "deal_settlement"),
        allowNull: false,
        defaultValue: "full",
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: "Pending",
    },
    amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
    },
    gateway: {
        type: DataTypes.STRING(50),
        defaultValue: "authorize_net",
    },
    authorizeTransactionId: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    authorizeSubscriptionId: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    authorizeEventId: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    invoiceNumber: {
        type: DataTypes.STRING(100),
        allowNull: true,
    },
});

module.exports = PaymentHistory;
