// models/EmailTemplate.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const EmailTemplate = sequelize.define(
    "EmailTemplate",
    {
        name: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
        },
        subject: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        body: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        category: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: "general",
        },
    },
    // { paranoid: true }
);

module.exports = EmailTemplate;
