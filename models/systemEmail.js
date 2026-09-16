const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

// BUG 5 FIX: Added proper fields for tracking sent emails
const SystemEmail = sequelize.define("SystemEmail", {
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: "users",
            key: "id"
        }
    },
    emailTemplateId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: "EmailTemplates",
            key: "id"
        }
    },
    campaignId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: "Campaigns",
            key: "id"
        }
    },
    receiverEmail: {
        type: DataTypes.STRING,
        allowNull: false
    },
    subject: {
        type: DataTypes.STRING,
        allowNull: false
    },
    status: {
        type: DataTypes.ENUM("pending", "sent", "failed", "delivered", "unsubscribed"),
        defaultValue: "pending",
        allowNull: false
    },
    sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: DataTypes.NOW
    },
    messageId: {
        type: DataTypes.STRING,
        allowNull: true
    },
    brevoUuid: {
        type: DataTypes.STRING,
        allowNull: true
    },
    opens: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    clicks: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    }
}, {
    timestamps: true,
});

module.exports = SystemEmail;
