const { Sequelize } = require("sequelize");
const mysql2 = require("mysql2");
require("dotenv").config();

const sequelize = new Sequelize({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    dialect: "mysql",
    dialectModule: mysql2,
    pool: {
        max: Number(process.env.DB_POOL_MAX || 10),
        min: 0,
        acquire: 30000000,
        idle: 10000,
    },
});

const syncDatabase = async () => {
    try {
        await sequelize.authenticate();

        await sequelize.sync({
            // force: true,
            // alter: true,
        });

        return sequelize;
    } catch (error) {
        console.error("Error occurred during synchronization with DB:", error);
        throw error;
    }
};

module.exports = sequelize;
module.exports.syncDatabase = syncDatabase;
