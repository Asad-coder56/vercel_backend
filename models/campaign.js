const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Campaign = sequelize.define(
    "Campaign",
    {
        name: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        audience: {
            type: DataTypes.STRING, // "Due in 3 Days", "Overdue Accounts", etc.
            allowNull: false,
        },
        templateId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: "EmailTemplates",
                key: "id",
            },
        },
        deliveryMode: {
            type: DataTypes.STRING, // "immediate", "schedule"
            allowNull: false,
            defaultValue: "immediate",
        },
        scheduledDate: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        recipientsCount: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
        },
        status: {
            type: DataTypes.STRING, // "Sent", "Scheduled", "Draft", "Failed"
            allowNull: false,
            defaultValue: "Draft",
        },
        openRate: {
            type: DataTypes.STRING,
            allowNull: true,
            defaultValue: "0%",
        },
        opens: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
        },
        clicks: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = Campaign;
