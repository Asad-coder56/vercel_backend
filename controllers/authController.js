const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const models = require("../models/index");
const emailer = require("../services/emailService");
const NodeCache = require("node-cache");
const { DATEONLY } = require("sequelize");

const nodeCache = new NodeCache();
require("dotenv").config();

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
const JWT_EXPIRES_IN = "7d";

const signup = async (req, res) => {
    try {
        let {
            email,
            password,
            confirmPassword,
        } = req.body;
        if (!email || !password || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "Email, password and confirm password are required",
            });
        }
        // Password validation
        if (password !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "Passwords do not match",
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 8 characters long",
            });
        }

        // Email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        email = email.toLowerCase();

        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Invalid email format",
            });
        }

        // Check for existing user by email
        const existingUser = await models.User.findOne({ where: { email: email } });
        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "Email already registered",
            });
        }


        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create User
        const user = await models.User.create({
            email,
            password: hashedPassword,
            role: "admin",
        });

        res.status(201).json({
            success: true,
            message: "Account created successfully",
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                },
            },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: `Internal server error : ${error.message}`,
            // error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};



const login = async (req, res) => {
    try {
        let { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required",
            });
        }
        email = email.toLowerCase();
        const user = await models.User.findOne({ where: { email: email } });
        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        // const isPasswordValid = await bcrypt.compare(password, user.password);
        // if (!isPasswordValid) {
        //     return res.status(401).json({
        //         success: false,
        //         message: "Invalid email or password",
        //     });
        // }

        if (user.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "Account is not active",
            });
        }

        const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, {
            expiresIn: JWT_EXPIRES_IN,
        });

        res.json({
            success: true,
            message: "Login successful",
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                },
                token,
            },
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({
            success: false,
            message: "Error logging in",
            error: error.message,
        });
    }
};

// forgotPassword.js
const forgotPassword = async (req, res) => {
    try {
        let { email } = req.body;
        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required",
            });
        }
        email = email.toLowerCase();

        const user = await models.User.findOne({ where: { email: email } });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        const OTP = Math.floor(100000 + Math.random() * 900000);
        await emailer.sendOTP(email, OTP);

        nodeCache.set(OTP.toString(), { email: email }, 600); // 10 minutes

        res.json({
            success: true,
            message: "OTP is sent to your email",
        });
    } catch (error) {
        console.error("Forgot password error:", error);
        res.status(500).json({
            success: false,
            message: "Error resetting password",
            error: error.message,
        });
    }
};

// resetPassword.js
const resetPassword = async (req, res) => {
    try {
        const { otp, password, confirmPassword } = req.body;
        if (!otp || !password || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "OTP, password and confirm password is required",
            });
        }

        if (confirmPassword !== password) {
            return res.status(400).json({
                success: false,
                message: "Password and confirm password does not match",
            });
        }

        const data = nodeCache.get(otp.toString());
        if (!data) {
            return res.status(400).json({
                success: false,
                message: "Invalid or expired OTP",
            });
        }

        const { email } = data;
        const user = await models.User.findOne({ where: { email: email } });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await models.User.update({ password: hashedPassword }, { where: { email: email } });

        nodeCache.del(otp.toString());

        res.json({
            success: true,
            message: "Password reset successfully",
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: "Error resetting password",
            error: err.message,
        });
    }
};

// selectWorkspace – admin only
// POST /api/auth/select-workspace
// Body: { workspaceRole: "admin" | "client" }
// Header: Authorization: Bearer <token>
const selectWorkspace = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ success: false, message: "No token provided" });
        }
        const token = authHeader.substring(7);
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch {
            return res.status(401).json({ success: false, message: "Invalid or expired token" });
        }

        const user = await models.User.findByPk(decoded.userId);
        if (!user) return res.status(401).json({ success: false, message: "User not found" });
        if (user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Only admins can select a workspace" });
        }
        if (user.status !== "active") {
            return res.status(403).json({ success: false, message: "Account is not active" });
        }

        const { workspaceRole } = req.body;
        const allowed = ["admin", "operations"];
        if (!workspaceRole || !allowed.includes(workspaceRole)) {
            return res.status(400).json({
                success: false,
                message: `workspaceRole must be one of: ${allowed.join(", ")}`,
            });
        }

        // Issue a scoped token that carries the active workspace
        const scopedToken = jwt.sign(
            { userId: user.id, email: user.email, role: user.role, activeWorkspace: workspaceRole },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        return res.json({
            success: true,
            message: `Workspace "${workspaceRole}" selected`,
            data: {
                user: { id: user.id, email: user.email, role: user.role, activeWorkspace: workspaceRole },
                token: scopedToken,
                redirectTo: workspaceRole === "admin" ? "/admin/dashboard" : "/operations/dashboard",
            },
        });
    } catch (error) {
        console.error("selectWorkspace error:", error);
        return res.status(500).json({ success: false, message: "Internal server error", error: error.message });
    }
};

module.exports = {
    signup,
    login,
    forgotPassword,
    resetPassword,
    selectWorkspace,
};
