const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Deal = sequelize.define(
    "Deal",
    {
        debtId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        // clientUserId: {
        //     type: DataTypes.INTEGER,
        //     allowNull: false,
        // },
        // adminUserId: {
        //     type: DataTypes.INTEGER,
        //     allowNull: true,
        // },
        customerUserId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        proposedAmount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
        },
        clientNote: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        counterAmount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
        },
        adminNote: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        status: {
            type: DataTypes.ENUM("pending", "accepted", "rejected", "countered"),
            defaultValue: "pending",
        },
        finalAmount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
        },
        negotiationHistory: {
            type: DataTypes.JSON,
            allowNull: true,
            defaultValue: [],
            validate: {
                isValidHistory(value) {
                    if (value && !Array.isArray(value)) {
                        throw new Error("negotiationHistory must be an array");
                    }
                    if (value) {
                        value.forEach((item) => {
                            if (!item.clientProposal || !item.adminProposal) {
                                throw new Error("Each history item must have clientProposal and adminProposal");
                            }
                        });
                    }
                },
            },
        },
    },
    {
        // paranoid: true,
        timestamps: true,
    }
);

module.exports = Deal;
