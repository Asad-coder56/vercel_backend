const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const cardDetails = sequelize.define("cardDetails", {
    customerProfileId:{
        type:DataTypes.STRING
    } ,
    paymentProfileId:{
        type:DataTypes.STRING
    },
    authorizeCustomerProfileId: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
    authorizePaymentProfileId: {
        type: DataTypes.STRING(255),
        allowNull: true,
    },
})


module.exports = cardDetails
