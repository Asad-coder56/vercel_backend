const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Installment = sequelize.define(
    "Installment",
    {
        amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
        },
        dueDate: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        status: {
            type: DataTypes.STRING(50),
            allowNull: false,
            defaultValue: "pending", // pending, processing, paid, failed, suspended
        },
        installmentNo: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        installmentType: {
            type: DataTypes.ENUM("monthly", "weekly", "quarterly"),
            allowNull: false,
            defaultValue: "monthly",
        },
        authorizeSubscriptionId: {
            type: DataTypes.STRING(255),
            allowNull: true,
        },
        authorizeTransactionId: {
            type: DataTypes.STRING(255),
            allowNull: true,
        },
        attemptCount: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        lastAttemptAt: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        paidAt: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    // { paranoid: true }
);

module.exports = Installment;
