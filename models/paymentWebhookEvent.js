const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const PaymentWebhookEvent = sequelize.define("PaymentWebhookEvent", {
    eventId: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
    },
    eventType: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    payload: {
        type: DataTypes.JSON,
        allowNull: false,
    },
    processedAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: "received", // received, processed, failed
    },
    errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
});

module.exports = PaymentWebhookEvent;
