const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const User = sequelize.define("user", {
    // username:{
    //     type: DataTypes.STRING,
    //     unique:true
    // },
    email:{
        type: DataTypes.STRING,
        allownull:false,
        unique:true
    },
    password:{
        type: DataTypes.STRING,
        allownull:false
    },
    role:{
        type: DataTypes.ENUM("admin","customer"),
        allownull:false
    },
    status: {
        type: DataTypes.ENUM("active", "suspended"),
        defaultValue: "active",
    }
})

module.exports = User