const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Customer = sequelize.define(
    "Customer",
    {
        FirstName: {
            type: DataTypes.STRING,
            allowNull: false, // Nullable based on the context
        },
        MiddleName: {
            type: DataTypes.STRING,
            allowNull: true, // Optional field
        },
        LastName: {
            type: DataTypes.STRING,
            allowNull: false, // Nullable based on the context
        },
        FileNumber: {
            type: DataTypes.STRING,
            allowNull: false, // Not nullable as it is likely a unique identifier
        },
        Address: {
            type: DataTypes.STRING,
            allowNull: true, // Nullable as per the data
        },
        City: {
            type: DataTypes.STRING,
            allowNull: true, // Nullable as per the data
        },
        State: {
            type: DataTypes.STRING,
            allowNull: true, // Nullable as per the data
        },
        Zip: {
            type: DataTypes.STRING,
            allowNull: true, // Not nullable as it is essential
        },
        SocialSecurityNumber: {
            type: DataTypes.STRING,
            allowNull: false, // Not nullable as it represents the Social Security Number
        },
        PrimaryPhone: {
            type: DataTypes.STRING,
            allowNull: true, // Nullable as it might not always be provided
        },
        WorkPhone: {
            type: DataTypes.STRING,
            allowNull: true, // Nullable as it might not always be provided
        },
        // EmailAddress: {
        //     type: DataTypes.STRING,
        //     allowNull: true, // Nullable as it might not always be provided
        // },
        BirthDate: {
            type: DataTypes.DATEONLY,
            allowNull: true, // Not nullable as it represents the customer's birth date
        },
        SpouseWorkPhone: {
            type: DataTypes.STRING,
            allowNull: true, // Nullable as it might not always be provided
        },
    },
    {
        // paranoid: true,
        // BUG 2 FIX: Add indexes for frequently queried fields
        indexes: [
            {
                fields: ['userId']
            },
            {
                fields: ['FirstName', 'LastName']
            },
            {
                fields: ['createdAt']
            }
        ]
    }
);

module.exports = Customer;
