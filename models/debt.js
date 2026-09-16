const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Debt = sequelize.define(
    "Debt",
    {
        customerId: {
            type: DataTypes.INTEGER,
            references: {
                model: "Customers",
                key: "id",
            },
            allowNull: false, // Foreign key linking to the Customer table
        },
        AccountNumber: {
            type: DataTypes.STRING,
            allowNull: false, // Not nullable as it is likely a unique identifier
        },
        OriginalBalance: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false, // Not nullable as it is financial data
        },
        currentBalance: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            defaultValue: 0,
        },
        OriginalCreditor: {
            type: DataTypes.STRING,
            allowNull: false, // Not nullable as it indicates the creditor
        },
        TypeOfDebt: {
            type: DataTypes.STRING,
            allowNull: false, // Not nullable as it specifies the type of debt
        },
        PaidToDate: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false, // Not nullable as it indicates the amount paid to date
        },

        dateAccountOpened: {
            type: DataTypes.DATEONLY,
            allowNull: false, // Not nullable as it represents the date the account was opened
        },
        dateChargedOff: {
            type: DataTypes.DATEONLY,
            allowNull: true, // Not nullable as it represents the date the account was charged off
        },
        chargedOffPrincipal: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true, // Not nullable as it represents the charged-off principal amount
        },
        ClientName: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        Portfolio: {
            type: DataTypes.STRING,
            allowNull: false, // Not nullable as it represents the portfolio
        },
        DatePlaced: {
            type: DataTypes.DATEONLY,
            allowNull: false, // Not nullable as it represents the date the debt was placed
        },
        StatusName: {
            type: DataTypes.STRING,
            allowNull: false, // Not nullable as it represents the status name
        },
        StatusType: {
            type: DataTypes.STRING,
            allowNull: false, // Not nullable as it represents the status type
        },
        status: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: "pending", // Possible values: 'pending', 'paid'
        },
    },
    {
        // paranoid: true,
        // BUG 2 FIX: Add indexes for frequently queried fields
        indexes: [
            {
                fields: ['customerId']
            },
            {
                fields: ['status']
            },
            {
                fields: ['AccountNumber']
            },
            {
                fields: ['customerId', 'status']
            }
        ]
    }
);

module.exports = Debt;
