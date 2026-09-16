const models = require("../models/index");
const bcrypt = require("bcryptjs");
const emailer = require("../services/emailService");
const { Op } = require("sequelize");
const xlsx = require("xlsx");
const { parse } = require("dotenv");
require("dotenv").config();

const formatPercent = (value) => {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return "0.0%";
    }

    return `${Math.min(100, numericValue).toFixed(1)}%`;
};

const calculateRate = (value, total) => {
    const numerator = Number(value) || 0;
    const denominator = Number(total) || 0;

    if (denominator <= 0) {
        return 0;
    }

    return Math.min(100, Math.round((numerator / denominator) * 100));
};

const sanitizePercentString = (value, fallback = '0%') => {
    const numericValue = Number(String(value ?? '').replace(/%/g, '').trim());

    if (!Number.isFinite(numericValue)) {
        return fallback;
    }

    const clampedValue = Math.min(100, Math.max(0, numericValue));
    return `${Number.isInteger(clampedValue) ? clampedValue : clampedValue.toFixed(1)}%`;
};

const dashboard = async (req, res) => {
    try {
        const { userId } = req.user;

        // Verify admin user
        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
            attributes: ["id", "email", "role"],
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        // Get current date for calculations
        const now = new Date();
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        // Calculate twelve months ago (first day of month 12 months ago)
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        twelveMonthsAgo.setDate(1);
        twelveMonthsAgo.setHours(0, 0, 0, 0);

        // Execute all queries in parallel for performance
        const [
            totalCustomers,
            customersThisWeek,
            totalDebtBalance,
            debtAddedThisWeek,
            activeInstallmentsCount,
            installmentsToday,
            totalPaymentsReceived,
            recentCustomers,
            allPayments,  // Changed from paymentTrends
            overdueInstallments,
            successfulDeals,
            topCustomersRaw,
        ] = await Promise.all([
            // 1. Total Customers
            models.Customer.count(),

            // 2. Customers added this week
            models.Customer.count({
                where: {
                    createdAt: { [Op.gte]: oneWeekAgo },
                },
            }),

            // 3. Total Debt Current Balance
            models.Debt.sum("currentBalance"),

            // 4. Debt added this week for percentage change
            models.Debt.sum("currentBalance", {
                where: {
                    createdAt: {
                        [Op.gte]: oneWeekAgo,
                    },
                },
            }),

            // 5. Active Installment Plans
            models.Installment.count({
                where: { status: "pending" },
                distinct: true,
                col: "debtId",
            }),

            // 6. Installments added today
            models.Installment.count({
                where: {
                    createdAt: {
                        [Op.gte]: new Date(now.setHours(0, 0, 0, 0)),
                    },
                },
            }),

            // 7. Total Payments Received (completed OR success)
            models.PaymentHistory.sum("amount", {
                where: { status: { [Op.in]: ["completed", "success"] } },
            }),

            // 8. Recently Joined Customers
            models.Customer.findAll({
                include: [
                    {
                        model: models.User,
                        attributes: ["id", "email"],
                        required: true,
                    },
                    {
                        model: models.Debt,
                        attributes: ["currentBalance"],
                        required: false,
                    },
                ],
                order: [["createdAt", "DESC"]],
                limit: 5,
                attributes: [
                    "id",
                    "FirstName",
                    "LastName",
                    "createdAt",
                    "userId",
                    [
                        models.sequelize.literal(`
                            (SELECT COUNT(*) 
                             FROM Deals 
                             WHERE Deals.customerUserId = Customer.userId 
                             AND Deals.status NOT IN ('rejected', 'accepted'))
                        `),
                        "activeDeals",
                    ],
                ],
            }),

            // 9. Get all payments for last 12 months for the filterable chart
            models.PaymentHistory.findAll({
                where: {
                    status: { [Op.in]: ["completed", "success"] },
                    createdAt: { [Op.gte]: twelveMonthsAgo },
                },
                attributes: ["amount", "createdAt"],
                raw: true,
            }),

            // 10. Overdue Installments
            models.Installment.count({
                where: {
                    status: "pending",
                    dueDate: { [Op.lt]: now },
                },
            }),

            // 11. Successful Deals
            models.Deal.count({
                where: { status: "accepted" },
            }),

            // 12. Top 5 Customers by Debt
            models.Customer.findAll({
                include: [
                    {
                        model: models.Debt,
                        attributes: [],
                        required: false,
                    },
                    {
                        model: models.User,
                        attributes: ["id", "email"],
                        required: true,
                    },
                ],
                attributes: [
                    "id",
                    "FirstName",
                    "LastName",
                    "userId",
                    [
                        models.sequelize.fn(
                            "COALESCE",
                            models.sequelize.fn("SUM", models.sequelize.col("Debts.currentBalance")),
                            0,
                        ),
                        "totalDebt",
                    ],
                    [
                        models.sequelize.literal(`
                            (SELECT COUNT(*) 
                             FROM Deals 
                             WHERE Deals.customerUserId = Customer.userId 
                             AND Deals.status NOT IN ('rejected', 'accepted'))
                        `),
                        "activeDeals",
                    ],
                ],
                group: [
                    "Customer.id",
                    "Customer.userId",
                    "user.id",
                    "user.email",
                    "Customer.FirstName",
                    "Customer.LastName",
                ],
                order: [[models.sequelize.literal("COALESCE(SUM(Debts.currentBalance), 0)"), "DESC"]],
                limit: 5,
                subQuery: false,
            }),
        ]);

        // Calculate derived metrics
        const totalDebt = totalDebtBalance || 0;
        const addedThisWeek = debtAddedThisWeek || 0;
        const previousTotal = totalDebt - addedThisWeek;

        let debtChange = previousTotal > 0 ? Math.round((addedThisWeek / previousTotal) * 100) : 0;

        // Cap the percentage change to a maximum of 100% and minimum of -100%
        if (debtChange > 100) debtChange = 100;
        if (debtChange < -100) debtChange = -100;

        const originalBalanceTotal = (await models.Debt.sum("OriginalBalance")) || 0;
        const collectionRate =
            originalBalanceTotal > 0
                ? Math.round(((originalBalanceTotal - totalDebt) / originalBalanceTotal) * 100)
                : 0;

        // FIXED: Process payment data for last 6 months
        const monthlyTotals = {};

        // Group payments by month-year
        allPayments.forEach(payment => {
            if (payment.createdAt) {
                const date = new Date(payment.createdAt);
                const monthYear = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

                if (!monthlyTotals[monthYear]) {
                    monthlyTotals[monthYear] = 0;
                }
                monthlyTotals[monthYear] += parseFloat(payment.amount) || 0;
            }
        });

        // Generate last 12 months with data
        const last12Months = [];
        for (let i = 11; i >= 0; i--) {
            const date = new Date();
            date.setMonth(date.getMonth() - i);

            const month = date.getMonth() + 1;
            const year = date.getFullYear();
            const monthKey = `${year}-${String(month).padStart(2, '0')}`;
            const monthName = date.toLocaleString('default', { month: 'short' });
            const shortYear = year.toString().slice(-2);

            last12Months.push({
                month: `${monthName} '${shortYear}`,
                amount: monthlyTotals[monthKey] || 0,
                fullMonth: monthName,
                year: year
            });
        }

        // Format recent customers
        const formattedRecentCustomers = recentCustomers.map((customer) => {
            const totalCustomerDebt = customer.Debts
                ? customer.Debts.reduce((sum, debt) => sum + (debt.currentBalance || 0), 0)
                : 0;

            return {
                id: customer.id,
                userId: customer.userId,
                name: `${customer.FirstName} ${customer.LastName}`,
                email: customer.user?.email || "No email",
                joinDate: customer.createdAt,
                totalDebt: totalCustomerDebt,
                status: "active",
                activeDeals: parseInt(customer.getDataValue("activeDeals") || 0),
            };
        });

        // Format top customers
        const formattedTopCustomers = topCustomersRaw.map((customer) => {
            return {
                id: customer.id,
                userId: customer.userId,
                name: `${customer.FirstName} ${customer.LastName}`,
                email: customer.user?.email || "No email",
                totalDebt: parseFloat(customer.totalDebt || 0),
                activeDeals: parseInt(customer.getDataValue("activeDeals") || 0),
            };
        });

        // Get additional stats
        const additionalPromises = await Promise.all([
            models.Debt.sum("OriginalBalance") - totalDebt || 0,
            models.PaymentHistory.count({ where: { status: { [Op.in]: ["pending"] } } }),
            models.Debt.count({ where: { status: "active" } }),
            models.Deal.count({ where: { status: "pending" } }),
            models.Installment.count(),
            models.Installment.count({ where: { status: "paid" } }),
        ]);

        const [totalDebtSettled, pendingPayments, totalActiveDebts, pendingDeals, totalInstallments, paidInstallments] =
            additionalPromises;

        // Construct final response
        const responseData = {
            success: true,
            data: {
                overviewCards: [
                    {
                        title: "Total Customers",
                        value: totalCustomers || 0,
                        change: customersThisWeek > 0 ? `+${customersThisWeek} this week` : "No change",
                        icon: "users",
                        color: "blue",
                    },
                    {
                        title: "Total Debt Managed",
                        value: `$${Number(totalDebt).toLocaleString()}`,
                        change: debtChange > 0 ? `+${debtChange}%` : debtChange < 0 ? `${debtChange}%` : "No change",
                        icon: "dollar",
                        color: "green",
                    },
                    {
                        title: "Active Installments",
                        value: activeInstallmentsCount || 0,
                        change: installmentsToday > 0 ? `+${installmentsToday} today` : "No change",
                        icon: "calendar",
                        color: "orange",
                    },
                    {
                        title: "Collection Rate",
                        value: `${collectionRate}%`,
                        change: collectionRate > 0 ? `+${collectionRate}%` : "No change",
                        icon: "trending-up",
                        color: "purple",
                    },
                ],
                admin: admin,
                monthlyTrends: last12Months,
                recentCustomers: formattedRecentCustomers,
                topCustomers: formattedTopCustomers,

                additionalStats: {
                    totalPaymentsReceived: totalPaymentsReceived || 0,
                    overdueInstallments: overdueInstallments || 0,
                    successfulDeals: successfulDeals || 0,
                    averageDebtPerCustomer: totalCustomers > 0 ? Math.round(totalDebt / totalCustomers) : 0,
                    totalDebtSettled: totalDebtSettled,
                    pendingPayments: pendingPayments,
                },

                quickStats: {
                    totalActiveDebts: totalActiveDebts,
                    pendingDeals: pendingDeals,
                    totalInstallments: totalInstallments,
                    paidInstallments: paidInstallments,
                },
            },
        };

        return res.status(200).json(responseData);
    } catch (error) {
        console.error("Dashboard error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error retrieving dashboard data",
            error: process.env.NODE_ENV === "development" ? error.message : undefined,
        });
    }
};

const clientProfile = async (req, res) => {
    try {
        const { customerUserId } = req.params;

        // Get customer user
        const customerUser = await models.User.findOne({
            where: { id: customerUserId, role: "customer" },
            include: [
                {
                    model: models.Customer,
                },
            ],
        });

        if (!customerUser || !customerUser.Customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        const customer = customerUser.Customer;
        const customerId = customer.id;
        const now = new Date();
        const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

        // Execute all queries in parallel
        const [
            totalDebtData,
            activeDealsCount,
            dealsThisMonth,
            totalSavings,
            activeDeals,
            paymentHistoryStats,
            recentPayments,
            monthlySettlementData,
            // NEW QUERIES FOR DYNAMIC CALCULATIONS
            DebtsTotal,
            dealsLastMonthData,
            acceptedDealsSavings,
            settlementRateData,
            lastMonthPayments,
            // top cards data
        ] = await Promise.all([
            // 1. Total Debt & Savings (Original)
            models.Debt.findOne({
                where: { customerId: customerId },
                attributes: [
                    [models.sequelize.fn("SUM", models.sequelize.col("OriginalBalance")), "totalOriginal"],
                    [models.sequelize.fn("SUM", models.sequelize.col("currentBalance")), "totalCurrent"],
                ],
                raw: true,
            }),

            // 2. Active Deals Count
            models.Deal.count({
                where: {
                    debtId: {
                        [Op.in]: models.sequelize.literal(`(SELECT id FROM Debts WHERE customerId = ${customerId})`),
                    },
                    status: { [Op.in]: ["pending", "countered"] },
                },
            }),

            // 3. Deals created this month
            models.Deal.count({
                where: {
                    debtId: {
                        [Op.in]: models.sequelize.literal(`(SELECT id FROM Debts WHERE customerId = ${customerId})`),
                    },
                    createdAt: { [Op.gte]: oneMonthAgo },
                },
            }),

            // 4. Total Savings (Original - Current) - Keep for reference
            models.Debt.findOne({
                where: { customerId: customerId },
                attributes: [
                    [
                        models.sequelize.fn(
                            "SUM",
                            models.sequelize.fn("COALESCE", models.sequelize.col("OriginalBalance"), 0),
                        ),
                        "original",
                    ],
                    [
                        models.sequelize.fn(
                            "SUM",
                            models.sequelize.fn("COALESCE", models.sequelize.col("currentBalance"), 0),
                        ),
                        "current",
                    ],
                ],
                raw: true,
            }),

            // 5. Active Deals with details
            models.Deal.findAll({
                where: {
                    debtId: {
                        [Op.in]: models.sequelize.literal(`(SELECT id FROM Debts WHERE customerId = ${customerId})`),
                    },
                    status: { [Op.in]: ["pending", "countered"] },
                },
                include: [
                    {
                        model: models.Debt,
                        attributes: ["OriginalBalance", "currentBalance", "AccountNumber"],
                    },
                ],
                order: [["createdAt", "DESC"]],
                limit: 5,
            }),

            // 6. Payment History Statistics
            models.PaymentHistory.findOne({
                where: {
                    userId: customerUserId,
                    status: "completed",
                },
                attributes: [
                    [models.sequelize.fn("COUNT", models.sequelize.col("id")), "totalPayments"],
                    [models.sequelize.fn("SUM", models.sequelize.col("amount")), "totalPaid"],
                ],
                raw: true,
            }),

            // 7. Recent Payments
            models.PaymentHistory.findAll({
                where: { userId: customerUserId },
                include: [
                    {
                        model: models.Debt,
                        attributes: ["AccountNumber", "OriginalBalance"],
                        where: { customerId: customerId },
                        required: true,
                    },
                ],
                order: [["createdAt", "DESC"]],
                limit: 5,
                attributes: ["id", "amount", "status", "paymentType", "createdAt"],
            }),

            // 8. Monthly Settlement Data for Graph
            models.PaymentHistory.findAll({
                where: {
                    userId: customerUserId,
                    status: "completed",
                    createdAt: { [Op.gte]: sixMonthsAgo },
                },
                attributes: [
                    [models.sequelize.fn("MONTH", models.sequelize.col("createdAt")), "month"],
                    [models.sequelize.fn("YEAR", models.sequelize.col("createdAt")), "year"],
                    [models.sequelize.fn("SUM", models.sequelize.col("amount")), "total"],
                ],
                group: ["year", "month"],
                order: [
                    ["year", "ASC"],
                    ["month", "ASC"],
                ],
                raw: true,
            }),

            // 9. NEW: Total original balance of unpaid debts
            models.Debt.findOne({
                where: {
                    customerId: customerId,
                },
                attributes: [
                    [models.sequelize.fn("SUM", models.sequelize.col("OriginalBalance")), "totalOriginalAmount"],
                ],
                raw: true,
            }),

            // 10. NEW: Deals data from last month for change calculation
            models.Deal.findAll({
                where: {
                    debtId: {
                        [Op.in]: models.sequelize.literal(`(SELECT id FROM Debts WHERE customerId = ${customerId})`),
                    },
                    createdAt: { [Op.gte]: oneMonthAgo },
                },
                attributes: ["id", "status", "createdAt"],
                raw: true,
            }),

            // 11. NEW: Accepted deals with their savings calculation
            models.Deal.findAll({
                where: {
                    debtId: {
                        [Op.in]: models.sequelize.literal(`(SELECT id FROM Debts WHERE customerId = ${customerId})`),
                    },
                    status: "accepted",
                },
                include: [
                    {
                        model: models.Debt,
                        attributes: ["OriginalBalance", "currentBalance"],
                    },
                ],
                raw: true,
            }),

            // 12. NEW: Settlement rate calculation data
            models.Deal.findAll({
                where: {
                    debtId: {
                        [Op.in]: models.sequelize.literal(`(SELECT id FROM Debts WHERE customerId = ${customerId})`),
                    },
                },
                attributes: ["id", "status"],
                raw: true,
            }),

            // 13. NEW: Payments in last 30 days for debt change calculation
            models.PaymentHistory.findOne({
                where: {
                    userId: customerUserId,
                    status: "completed",
                    createdAt: { [Op.gte]: oneMonthAgo },
                },
                attributes: [[models.sequelize.fn("SUM", models.sequelize.col("amount")), "lastMonthPaid"]],
                raw: true,
            }),
        ]);

        // Calculate dynamic metrics based on your requirements

        // Calculate debt change: payments made in last 30 days vs current balance of unpaid debts
        const lastMonthPaid = parseFloat(lastMonthPayments?.lastMonthPaid || 0);
        const totalCurrentBalanceUnpaid = await models.Debt.sum("currentBalance", {
            where: {
                customerId: customerId,
                status: { [Op.ne]: "paid" },
            },
        });
        const currentTotalUnpaid = parseFloat(totalCurrentBalanceUnpaid || 0);

        // 1. Total Debt: Sum of current balances of unpaid debts
        const totalDebt = currentTotalUnpaid;

        // Debt change percentage: (payments made last month) / (current unpaid balance) * 100
        let debtChangePercentage = 0;
        if (currentTotalUnpaid > 0 && lastMonthPaid > 0) {
            debtChangePercentage = Math.round((lastMonthPaid / currentTotalUnpaid) * 100);
        }

        // 2. Active Deals: Deals created in last 30 days
        const dealsInLastMonth = dealsLastMonthData.length;

        // Accepted deals in last 30 days
        const acceptedDealsLastMonth = dealsLastMonthData.filter((deal) => deal.status === "accepted").length;

        // Active deals change percentage: (accepted deals / total deals last month) * 100
        let dealsChangePercentage = 0;
        if (dealsInLastMonth > 0) {
            dealsChangePercentage = Math.round((acceptedDealsLastMonth / dealsInLastMonth) * 100);
        }

        // 3. Total Savings: Sum of (original debt - final deal amount) for accepted deals
        let totalSavingsAmount = 0;
        if (acceptedDealsSavings && acceptedDealsSavings.length > 0) {
            totalSavingsAmount = acceptedDealsSavings.reduce((total, deal) => {
                const original = parseFloat(deal["Debt.OriginalBalance"] || 0);
                const final = parseFloat(deal.finalAmount || deal.counterAmount || deal.proposedAmount || 0);
                if (original > 0 && final > 0) {
                    return total + (original - final);
                }
                return total;
            }, 0);
        }

        // Calculate savings change: Compare with previous month (for simplicity, using same logic as debt)
        let savingsChangePercentage = 0;
        if (lastMonthPaid > 0) {
            // Savings change is proportional to payments made
            savingsChangePercentage = Math.round((lastMonthPaid / totalSavingsAmount) * 100);
        }

        // 4. Settlement Rate: (Total Original Debt - Total Current Debt) / Total Original Debt * 100
        const grandTotalOriginal = parseFloat(totalDebtData?.totalOriginal || 0);
        const grandTotalCurrent = parseFloat(totalDebtData?.totalCurrent || 0);
        let settlementRate = 0;
        if (grandTotalOriginal > 0) {
            settlementRate = Math.round(((grandTotalOriginal - grandTotalCurrent) / grandTotalOriginal) * 100);
        }
        const acceptedDealsCount = settlementRateData.filter((deal) => deal.status === "accepted").length;

        // Calculate deals change percentage for original logic (keep as fallback)
        const dealsChange =
            dealsThisMonth > 0 ? Math.round((dealsThisMonth / (activeDealsCount - dealsThisMonth)) * 100) : 0;

        // Format monthly settlement data for graph
        const monthlyData = monthlySettlementData.map((item) => {
            const date = new Date();
            date.setMonth(item.month - 1);
            date.setFullYear(item.year);
            return {
                month: date.toLocaleString("default", { month: "short" }),
                year: item.year,
                amount: parseFloat(item.total) || 0,
            };
        });

        // Fill missing months
        const last6Months = [];
        for (let i = 5; i >= 0; i--) {
            const date = new Date();
            date.setMonth(date.getMonth() - i);
            const monthName = date.toLocaleString("default", { month: "short" });
            const monthData = monthlyData.find((m) => m.month === monthName);
            last6Months.push({
                month: monthName,
                amount: monthData ? monthData.amount : 0,
            });
        }

        // Format active deals
        const formattedActiveDeals = activeDeals.map((deal) => {
            const dealData = deal.toJSON();
            const originalBalance = dealData.Debt?.OriginalBalance || 0;
            const proposedAmount = dealData.proposedAmount || 0;
            const savings = originalBalance - proposedAmount;
            const reduction = originalBalance > 0 ? Math.round((savings / originalBalance) * 100) : 0;
            const counterAmount = dealData.counterAmount;

            return {
                id: dealData.id,
                dealNumber: `#${dealData.id}`,
                type: dealData.status === "countered" ? "countered" : "pending",
                submittedDate: dealData.createdAt,
                originalAmount: originalBalance,
                proposedAmount: proposedAmount,
                counterAmount: counterAmount,
                savings: savings,
                reduction: reduction,
                status: dealData.status,
                lastUpdated: dealData.updatedAt,
                accountNumber: dealData.Debt?.AccountNumber,
            };
        });

        // Format recent payments
        const formattedRecentPayments = recentPayments.map((payment) => {
            return {
                id: payment.id,
                totalDebt: payment.Debt.OriginalBalance,
                amount: payment.amount,
                status: payment.status,
                type: payment.paymentType,
                date: payment.createdAt,
                accountNumber: payment.Debt?.AccountNumber,
            };
        });

        // Construct response
        const responseData = {
            success: true,
            data: {
                // Overview Cards
                overviewCards: [
                    {
                        title: "Total Debt",
                        value: `$${Number(totalDebt).toLocaleString()}`,
                        change: debtChangePercentage > 0 ? `-${debtChangePercentage}%` : "No change",
                        icon: "dollar",
                        color: "red",
                    },
                    {
                        title: "Active Deals",
                        value: activeDealsCount || 0,
                        change: dealsChangePercentage > 0 ? `+${dealsChangePercentage}% this month` : "No change",
                        icon: "handshake",
                        color: "blue",
                    },
                    {
                        title: "Total Savings",
                        value: `$${Number(totalSavingsAmount).toLocaleString()}`,
                        change: savingsChangePercentage > 0 ? `+${savingsChangePercentage}%` : "No savings yet",
                        icon: "savings",
                        color: "green",
                    },
                    {
                        title: "Settlement Rate",
                        value: `${settlementRate}%`,
                        change: settlementRate > 0 ? `+${settlementRate}%` : "No progress",
                        icon: "trending-up",
                        color: "purple",
                    },
                ],

                // Debt Resolution Progress Graph
                monthlySettlementTrend: last6Months,

                // Active Deals
                activeDeals: formattedActiveDeals,

                // Recent Payments
                recentPayments: formattedRecentPayments,

                // Additional Stats
                additionalStats: {
                    totalPaymentsMade: parseInt(paymentHistoryStats?.totalPayments || 0),
                    totalAmountPaid: parseFloat(paymentHistoryStats?.totalPaid || 0),
                    averagePayment:
                        paymentHistoryStats?.totalPayments > 0
                            ? Math.round(
                                parseFloat(paymentHistoryStats?.totalPaid || 0) /
                                parseInt(paymentHistoryStats?.totalPayments || 1),
                            )
                            : 0,
                    pendingPayments: await models.PaymentHistory.count({
                        where: { userId: customerUserId, status: "pending" },
                    }),
                    acceptedDeals: acceptedDealsCount,
                },

                // Customer Info
                customerInfo: {
                    name: `${customer.FirstName} ${customer.LastName}`,
                    email: customerUser.email,
                    customerId: customer.id,
                    joinDate: customerUser.createdAt,
                },
            },
        };

        return res.status(200).json(responseData);
    } catch (err) {
        console.error("Client dashboard error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const getAllCustomers = async (req, res) => {
    try {
        const id = req.user.userId;
        if (!id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized, due to missing id",
            });
        }
        if (req.user.role !== "admin") {
            return res.status(401).json({
                success: false,
                message: "Unauthorized",
            });
        }

        // BUG 2 FIX: Add pagination support
        const { page = 1, limit = 10000, search = "" } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Build where clause for search
        const whereClause = {};
        if (search) {
            whereClause[Op.or] = [
                { FirstName: { [Op.like]: `%${search}%` } },
                { LastName: { [Op.like]: `%${search}%` } },
                { PrimaryPhone: { [Op.like]: `%${search}%` } },
            ];
        }

        const { count, rows: customers } = await models.Customer.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: models.User,
                    attributes: ["email"],
                    // BUG 2 FIX: Search by email too
                    ...(search && {
                        where: {
                            email: { [Op.like]: `%${search}%` },
                        },
                        required: false,
                    }),
                },
                {
                    model: models.Debt,
                    attributes: [
                        "id",
                        "AccountNumber",
                        "OriginalBalance",
                        "PaidToDate",
                        "OriginalCreditor",
                        "TypeOfDebt",
                        "DatePlaced",
                        "status",
                        "currentBalance",
                    ],
                },
            ],
            limit: parseInt(limit),
            offset: offset,
            order: [["createdAt", "DESC"]],
            distinct: true, // Important for accurate count with includes
        });

        return res.status(200).json({
            success: true,
            data: customers,
            pagination: {
                total: count,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(count / parseInt(limit)),
            },
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Internal server error retrieving dashboard data: ${err.message}`,
        });
    }
};

const generateRandomPassword = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+";
    const length = Math.floor(Math.random() * 8) + 6;
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

const parseDate = (value) => {
    if (!value) return null;

    if (typeof value === "number") {
        const epoch = new Date(1899, 11, 30);
        const date = new Date(epoch.getTime() + value * 86400000);
        return isNaN(date) ? null : date;
    }

    const date = new Date(value);
    return isNaN(date) ? null : date;
};

/* ================= MAIN UPLOAD ================= */

const uploadExcel = async (req, res) => {
    console.log("📥 Upload Excel started");

    if (!req.file) {
        console.log("❌ No file uploaded");
        return res.status(400).json({ message: "Excel file required" });
    }

    const transaction = await models.sequelize.transaction();
    const loginCredentialJobs = [];
    const adminNotificationJobs = [];
    const results = [];

    try {
        console.log("📄 Parsing Excel file");
        const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

        console.log(`📊 Total rows found: ${rows.length}`);

        if (!rows.length) {
            await transaction.rollback();
            console.log("❌ Excel file is empty");
            return res.status(400).json({ message: "Empty file" });
        }

        const requiredFields = [
            "FirstName",
            "LastName",
            "EmailAddress",
            "BirthDate",
            "AccountNumber",
            "FileNumber",
            "ClientName",
            "DatePlaced",
            "SocialSecurityNumber",
            "OriginalBalance",
        ];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = i + 2;
            console.log(`➡️ Processing row ${rowNumber}:`, row);

            try {
                const missingFields = requiredFields.filter(
                    (field) => !row[field] || row[field].toString().trim() === "",
                );

                if (missingFields.length) {
                    const reason = `Missing required fields: ${missingFields.join(", ")}`;
                    console.log(`⚠️ Row ${rowNumber} skipped - ${reason}`);

                    results.push({
                        row: rowNumber,
                        email: row.EmailAddress || null,
                        success: false,
                        reason: reason,
                    });
                    adminNotificationJobs.push({
                        row: rowNumber,
                        email: row.EmailAddress || null,
                        reason: reason,
                    });
                    continue;
                }

                const email = row.EmailAddress.toString().trim();
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    const reason = "Invalid email format";
                    console.log(`⚠️ Row ${rowNumber} skipped - ${reason}`);
                    results.push({ row: rowNumber, email, success: false, reason });
                    adminNotificationJobs.push({ row: rowNumber, email, reason });
                    continue;
                }

                const birthDate = parseDate(row.BirthDate);
                const datePlaced = parseDate(row.DatePlaced);
                if (!datePlaced) {
                    const reason = "Invalid DatePlaced";
                    console.log(`⚠️ Row ${rowNumber} skipped - ${reason}`);
                    results.push({ row: rowNumber, email, success: false, reason });
                    adminNotificationJobs.push({ row: rowNumber, email, reason });
                    continue;
                }

                let user = await models.User.findOne({ where: { email }, transaction });
                if (user) {
                    console.log(`ℹ️ Row ${rowNumber} skipped (already exists): ${email}`);
                    results.push({ row: rowNumber, email, success: true, skipped: true, reason: "Already exists in system" });
                    continue;
                }

                const plainPassword = generateRandomPassword();
                const hashedPassword = await bcrypt.hash(plainPassword, 10);

                console.log(`🔹 Creating User for ${email}`);
                user = await models.User.create({ email, role: "customer", password: hashedPassword }, { transaction });

                // const fileNumber = `FN-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
                const socialSecurityNumber = row.SocialSecurityNumber
                    ? row.SocialSecurityNumber.toString().trim()
                    : `PLACEHOLDER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

                console.log(`🔹 Creating Customer for ${email}`);
                const customer = await models.Customer.create(
                    {
                        FirstName: row.FirstName.toString().trim(),
                        MiddleMiddleName: row.MiddleName ? row.MiddleName.toString().trim() : null,
                        LastName: row.LastName.toString().trim(),
                        FileNumber: row.FileNumber,
                        Address: row.Address ? row.Address.toString().trim() : null,
                        City: row.City ? row.City.toString().trim() : null,
                        State: row.State ? row.State.toString().trim() : null,
                        Zip: row.Zip ? row.Zip.toString().trim() : null,
                        SocialSecurityNumber: socialSecurityNumber,
                        PrimaryPhone: row.PrimaryPhone ? row.PrimaryPhone.toString().trim() : null,
                        WorkPhone: row.WorkPhone ? row.WorkPhone.toString().trim() : null,
                        BirthDate: birthDate,
                        SpouseWorkPhone: row.SpouseWorkPhone ? row.SpouseWorkPhone.toString().trim() : null,

                        userId: user.id,
                    },
                    { transaction },
                );

                const debtData = {
                    customerId: customer.id,
                    AccountNumber: row.AccountNumber.toString().trim(),
                    OriginalBalance: parseFloat(row.OriginalBalance) || 0,
                    currentBalance: parseFloat(row.OriginalBalance) || 0,
                    ClientName: row.ClientName.toString().trim(),
                    DatePlaced: datePlaced,
                    OriginalCreditor: row.OriginalCreditor ? row.OriginalCreditor.toString().trim() : "Unknown",
                    TypeOfDebt: row.TypeOfDebt ? row.TypeOfDebt.toString().trim() : "Unknown",
                    PaidToDate: row.PaidToDate ? parseFloat(row.PaidToDate) : 0,
                    dateAccountOpened: row.dateAccountOpened ? parseDate(row.dateAccountOpened) : datePlaced,
                    Portfolio: row.Portfolio ? row.Portfolio.toString().trim() : "Default",
                    StatusName: row.StatusName ? row.StatusName.toString().trim() : "Active",
                    StatusType: row.StatusType ? row.StatusType.toString().trim() : "Active",
                    status: "pending",
                };

                if (row.dateChargedOff) {
                    const dateChargedOff = parseDate(row.dateChargedOff);
                    if (dateChargedOff) debtData.dateChargedOff = dateChargedOff;
                }

                if (row.chargedOffPrincipal) debtData.chargedOffPrincipal = parseFloat(row.chargedOffPrincipal);

                console.log(`🔹 Creating Debt for ${email}`);
                await models.Debt.create(debtData, { transaction });

                console.log(`📩 Queueing login credentials email for ${email}`);
                loginCredentialJobs.push({
                    to: email,
                    password: plainPassword,
                    firstName: row.FirstName,
                    userId: user.id,
                });

                results.push({ row: rowNumber, email, success: true });
            } catch (rowErr) {
                const reason = `Processing error: ${rowErr.message}`;
                console.log(`❌ Row ${rowNumber} failed - ${reason}`);
                results.push({ row: rowNumber, email: row.Email || null, success: false, reason });
                adminNotificationJobs.push({ row: rowNumber, email: row.Email || null, reason });
            }
        }

        console.log("💾 Committing transaction");
        await transaction.commit();

        console.log("📤 Sending login credentials emails");
        for (const job of loginCredentialJobs) {
            try {
                console.log("📧 Sending email to:", job.to);
                await emailer.sendLoginCredentialsEmail(job);
                console.log("✅ Email sent to:", job.to);
            } catch (emailErr) {
                console.error(`❌ Failed to send email to ${job.to}:`, emailErr.message);
                // Continue with other emails even if one fails
            }
        }

        if (adminNotificationJobs.length > 0) {
            console.log("📢 Sending admin notifications for failed rows");
            const admins = await models.User.findAll({ where: { role: "admin" }, attributes: ["id", "email"] });

            const failedRowsList = adminNotificationJobs
                .map((n) => `<tr><td>${n.row}</td><td>${n.email || "N/A"}</td><td>${n.reason}</td></tr>`)
                .join("");

            const notificationBody = `
                <h3>Excel Upload - Row Validation Failures</h3>
                <p><strong>Total Failed Rows:</strong> ${adminNotificationJobs.length}</p>
                <table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse;">
                    <thead>
                        <tr><th>Row Number</th><th>Email</th><th>Reason</th></tr>
                    </thead>
                    <tbody>${failedRowsList}</tbody>
                </table>
            `;

            for (const admin of admins) {
                console.log("📧 Notifying admin:", admin.email);
                await emailer.sendIndividualEmail({
                    user: { id: admin.id, email: admin.email },
                    subject: "Excel Upload - Row Validation Failed",
                    body: notificationBody,
                    templateId: null,
                });
            }
        }

        const total = rows.length;
        const imported = results.filter((r) => r.success && !r.skipped).length;
        const skipped = results.filter((r) => r.skipped).length;
        const failed = results.filter((r) => !r.success).length;

        console.log(`✅ Upload finished - Total: ${total}, Imported: ${imported}, Skipped: ${skipped}, Failed: ${failed}`);
        return res.status(200).json({ total, imported, success: imported, skipped, failed, results });
    } catch (err) {
        await transaction.rollback();
        console.error("❌ Upload Excel Error:", err);
        return res.status(500).json({ message: "Upload failed", error: err.message });
    }
};

const getAllDeals = async (req, res) => {
    try {
        const { userId } = req.user;

        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        const { status, page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;

        const whereClause = {};
        if (status && ["pending", "accepted", "rejected", "countered"].includes(status)) {
            whereClause.status = status;
        }

        const deals = await models.Deal.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: models.Debt,
                    include: [
                        {
                            model: models.Customer,
                            include: [{ model: models.User, attributes: ["email"] }],
                            attributes: ["id", "FirstName", "LastName"],
                        },
                    ],
                    attributes: ["id", "AccountNumber", "OriginalBalance", "currentBalance"],
                },
            ],
            order: [["createdAt", "DESC"]],
            limit: parseInt(limit),
            offset: parseInt(offset),
        });

        return res.status(200).json({
            success: true,
            data: {
                deals: deals.rows,
                total: deals.count,
                page: parseInt(page),
                totalPages: Math.ceil(deals.count / limit),
            },
        });
    } catch (err) {
        console.error("Get all deals error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

// Get single deal details
const getDealDetails = async (req, res) => {
    try {
        const { userId } = req.user;
        const { dealId } = req.params;

        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        const deal = await models.Deal.findOne({
            where: { id: dealId },
            include: [
                {
                    model: models.Debt,
                    include: [
                        {
                            model: models.Customer,
                            include: [{ model: models.User, attributes: ["email", "createdAt"] }],
                        },
                    ],
                },
            ],
        });

        if (!deal) {
            return res.status(404).json({
                success: false,
                message: "Deal not found",
            });
        }

        return res.status(200).json({
            success: true,
            data: deal,
        });
    } catch (err) {
        console.error("Get deal details error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

// Deals manager (accept/reject/counter)
const buildCustomerDealEmail = ({ action, deal, adminNote, counterAmount }) => {
    const customer = deal.Debt.Customer;
    const debt = deal.Debt;

    let title = "";
    let details = "";

    if (action === "accept") {
        title = "✅ Your Deal Has Been Accepted";
        details = `
            <p><strong>Original Debt:</strong> $${debt.OriginalBalance}</p>
            <p><strong>Final Settlement Amount:</strong> $${deal.finalAmount}</p>
            <p><strong>Status:</strong> Deal accepted and closed</p>
        `;
    }

    if (action === "reject") {
        title = "❌ Your Deal Has Been Rejected";
        details = `
            <p><strong>Original Debt:</strong> $${debt.OriginalBalance}</p>
            <p><strong>Admin Note:</strong> ${adminNote}</p>
        `;
    }

    if (action === "counter") {
        title = "🔁 New Counter Offer from Admin";
        details = `
            <p><strong>Original Debt:</strong> $${debt.OriginalBalance}</p>
            <p><strong>Your Proposed Amount:</strong> $${deal.proposedAmount}</p>
            <p><strong>Admin Counter Offer:</strong> $${counterAmount}</p>
            <p><strong>Admin Note:</strong> ${adminNote || "No note provided"}</p>
        `;
    }

    return `
        <div style="font-family: Arial; color:#333; line-height:1.6">
            <h2>${title}</h2>
            <p><strong>Customer:</strong> ${customer.FirstName} ${customer.LastName}</p>
            <p><strong>Deal ID:</strong> ${deal.id}</p>
            ${details}
            <hr/>
            <p><b>TruNorth System Notification</b></p>
        </div>
    `;
};

// Deals manager (accept/reject/counter)
const dealsManager = async (req, res) => {
    try {
        const { userId } = req.user;
        const { dealId, action, counterAmount, adminNote } = req.body;

        // Verify admin
        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        // Check required fields
        if (!dealId || !action) {
            return res.status(400).json({
                success: false,
                message: "Deal ID and action are required",
            });
        }

        // Get the deal
        // let deal = await models.Deal.findOne({
        //     where: { id: dealId },
        //     include: [
        //         {
        //             model: models.Debt,
        //             include: [
        //                 {
        //                     model: models.Customer,
        //                     include: [{ model: models.User, attributes: ["id", "email"] }],
        //                 },
        //             ],
        //         },
        //     ],
        // });
        let deal = await models.Deal.findOne({ where: { id: dealId } })
        let debt = await models.Debt.findOne({ where: { id: deal.debtId } })
        let customer = await models.Customer.findOne({ where: { id: debt.customerId } })
        let user = await models.User.findOne({ where: { id: customer.userId }, attributes: ["id", "email"] })
        deal.Debt = debt
        deal.Debt.Customer = customer
        deal.Debt.Customer.User = user
        if (counterAmount && (isNaN(parseFloat(counterAmount)))) {
            if (parseFloat(counterAmount) <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Counter amount must be a positive number",
                });
            }
            if (parseFloat(counterAmount) >= deal.proposedAmount) {
                return res.status(400).json({
                    success: false,
                    message: "Counter amount must be less than the proposed amount",
                });
            }
            if (parseFloat(counterAmount) >= debt.OriginalBalance) {
                return res.status(400).json({
                    success: false,
                    message: "Counter amount must be less than the original debt balance",
                });
            }
        }

        if (!deal) {
            return res.status(404).json({
                success: false,
                message: "Deal not found",
            });
        }

        // Initialize negotiationHistory if not exists
        if (!deal.negotiationHistory) {
            deal.negotiationHistory = [];
        }
        // if (!deal.Debt.Customer.User) {
        //     return res.status(400).json({
        //         success: false,
        //         message: "Customer does not have an associated user account",
        //     });
        // }

        const customerEmail = deal.Debt.Customer.User.email;

        // Get current timestamp
        // const timestamp = new Date().toISOString();

        switch (action.toLowerCase()) {
            case "accept":
                // Admin accepts the current proposed amount
                await deal.update({
                    status: "accepted",
                    finalAmount: deal.proposedAmount, // Store proposed as final
                    adminNote: adminNote || "Deal accepted",
                    acceptedAt: new Date(),
                    // Do NOT add to negotiationHistory when admin accepts
                });

                // BUG 1 FIX: Do NOT create PaymentHistory or update debt balance here.
                // Deal acceptance is just an agreement on amount - actual payment happens separately.

                deal = await models.Deal.findOne({ where: { id: dealId }, include: [{ model: models.Debt, include: [{ model: models.Customer, include: [{ model: models.User }] }] }] });

                await emailer.sendDealEmail({
                    email: customerEmail,
                    body: buildCustomerDealEmail({
                        action: "accept",
                        deal,
                    }),
                });
                return res.status(200).json({
                    success: true,
                    message: "Deal accepted successfully",
                    data: deal,
                });

            case "reject":
                if (!adminNote || adminNote.trim() === "") {
                    return res.status(400).json({
                        success: false,
                        message: "Admin note is required when rejecting a deal",
                    });
                }

                // Admin rejects the deal
                await deal.update({
                    status: "rejected",
                    adminNote: adminNote.trim(),
                    // Do NOT add to negotiationHistory when admin rejects
                });

                await emailer.sendDealEmail({
                    email: customerEmail,
                    body: buildCustomerDealEmail({
                        action: "reject",
                        deal,
                        adminNote: adminNote.trim()
                    }),
                });

                return res.status(200).json({
                    success: true,
                    message: "Deal rejected",
                    data: deal,
                });

            case "counter":
                if (!counterAmount || isNaN(parseFloat(counterAmount)) || parseFloat(counterAmount) <= 0) {
                    return res.status(400).json({
                        success: false,
                        message: "Valid positive counter amount is required",
                    });
                }

                const counterNum = parseFloat(counterAmount);

                // Admin makes counter offer
                await deal.update({
                    status: "countered",
                    counterAmount: counterNum,
                    adminNote: adminNote ? adminNote : "No note provided",
                    // Do NOT add to negotiationHistory - will be added when customer responds
                });

                await emailer.sendDealEmail({
                    email: customerEmail,
                    body: buildCustomerDealEmail({
                        action: "counter",
                        deal,
                        adminNote: adminNote ? adminNote : "No note provided",
                        counterAmount: counterNum,
                    }),
                });

                return res.status(200).json({
                    success: true,
                    message: "Counter offer sent",
                    data: {
                        ...deal.toJSON(),
                        counterAmount: counterNum,
                    },
                });

            default:
                return res.status(400).json({
                    success: false,
                    message: "Invalid action. Use 'accept', 'reject', or 'counter'",
                });
        }
    } catch (err) {
        console.error("Deals manager error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const getDealHistory = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { dealId } = req.params;

        if (!dealId) {
            return res.status(400).json({
                success: false,
                message: "Deal ID is required",
            });
        }

        // Get the deal
        const deal = await models.Deal.findOne({
            where: { id: dealId },
            include: [
                {
                    model: models.Debt,
                    include: [
                        {
                            model: models.Customer,
                            where: { userId: userId },
                            required: false,
                        },
                    ],
                },
            ],
        });

        if (!deal) {
            return res.status(404).json({
                success: false,
                message: "Deal not found",
            });
        }

        // Verify access (customer or admin)
        const user = await models.User.findOne({ where: { id: userId } });
        const isAdmin = user.role === "admin";
        const isCustomer = deal.Debt?.Customer?.userId === userId;

        if (!isAdmin && !isCustomer) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized to view this deal",
            });
        }

        // Return negotiation history in chronological order
        return res.status(200).json({
            success: true,
            message: "Deal history retrieved successfully",
            data: {
                deal: {
                    id: deal.id,
                    proposedAmount: deal.proposedAmount,
                    counterAmount: deal.counterAmount,
                    finalAmount: deal.finalAmount,
                    status: deal.status,
                    createdAt: deal.createdAt,
                },
                negotiationHistory: deal.negotiationHistory || [], // Already in chronological order
                currentRound: {
                    proposedAmount: deal.proposedAmount,
                    counterAmount: deal.counterAmount,
                    adminNote: deal.adminNote,
                },
            },
        });
    } catch (err) {
        console.error("Get deal history error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const getTemplateById = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "User id not provided",
            });
        }
        if (req.user.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }
        const templateId = req.params.templateId;
        if (!templateId) {
            return res.status(400).json({
                success: false,
                message: "Template id not provided",
            });
        }
        const template = await models.EmailTemplate.findOne({
            where: { id: templateId },
        });
        if (!template) {
            return res.status(404).json({
                success: false,
                message: "Template not found",
            });
        }
        return res.status(200).json({
            success: true,
            message: "Template found",
            data: template,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error : ${err.message}`,
        });
    }
};

const getTemplateByName = async (req, res) => {
    try {
        const { userId } = req.user;

        // Verify admin
        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        const { templateName } = req.params;

        if (!templateName || templateName.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Template name is required",
            });
        }

        const template = await models.EmailTemplate.findOne({
            where: {
                name: templateName.trim(),
            },
        });

        if (!template) {
            return res.status(404).json({
                success: false,
                message: "Email template not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Email template retrieved successfully",
            data: template,
        });
    } catch (err) {
        console.error("Get template by name error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const createTemplate = async (req, res) => {
    try {
        const { userId } = req.user;

        // Verify admin
        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        const { name, subject, body, category } = req.body;

        // Validate required fields
        if (!name || !subject || !body) {
            return res.status(400).json({
                success: false,
                message: "Name, subject, and body are required",
            });
        }

        // Trim and validate
        const trimmedName = name.trim();
        const trimmedSubject = subject.trim();
        const trimmedBody = body.trim();

        if (!trimmedName || !trimmedSubject || !trimmedBody) {
            return res.status(400).json({
                success: false,
                message: "Name, subject, and body cannot be empty",
            });
        }

        // Check if template with same name already exists
        const existingTemplate = await models.EmailTemplate.findOne({
            where: { name: trimmedName },
        });

        if (existingTemplate) {
            return res.status(409).json({
                success: false,
                message: "Template with this name already exists",
            });
        }

        // Create new template
        const newTemplate = await models.EmailTemplate.create({
            name: trimmedName,
            subject: trimmedSubject,
            body: trimmedBody,
            category: category ? category.trim().toLowerCase() : 'general',
        });

        return res.status(201).json({
            success: true,
            message: "Email template created successfully",
            data: newTemplate,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

// Get all templates
const getAllTemplates = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({ success: false, message: "User id not provided" });
        }
        if (req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Access denied. Admin only." });
        }

        const templates = await models.EmailTemplate.findAll({
            order: [["createdAt", "DESC"]],
            attributes: {
                include: [
                    [
                        models.sequelize.literal(
                            `(SELECT COUNT(*) FROM Campaigns WHERE Campaigns.templateId = EmailTemplate.id)`
                        ),
                        'usageCount'
                    ]
                ]
            }
        });

        // Attach usageCount to each template plain object
        const data = templates.map(t => ({
            ...t.toJSON(),
            usageCount: parseInt(t.getDataValue('usageCount') || 0, 10)
        }));

        return res.status(200).json({ success: true, message: "Templates found", data });
    } catch (err) {
        return res.status(500).json({ success: false, message: `Server error : ${err.message}` });
    }
};

// Update template
const updateTemplate = async (req, res) => {
    try {
        const { userId } = req.user;

        // Verify admin
        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        const { templateId } = req.params;
        const { name, subject, body, category } = req.body;

        if (!templateId) {
            return res.status(400).json({
                success: false,
                message: "Template ID is required",
            });
        }

        // Find template
        const template = await models.EmailTemplate.findOne({
            where: { id: templateId },
        });

        if (!template) {
            return res.status(404).json({
                success: false,
                message: "Template not found",
            });
        }

        // Update template
        await template.update({
            name: name || template.name,
            subject: subject || template.subject,
            body: body || template.body,
            category: category || template.category,
            updatedAt: new Date(),
        });

        return res.status(200).json({
            success: true,
            message: "Template updated successfully",
            data: template,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

// Delete template
const deleteTemplate = async (req, res) => {
    try {
        const { userId } = req.user;

        // Verify admin
        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        const { templateId } = req.params;

        if (!templateId) {
            return res.status(400).json({
                success: false,
                message: "Template ID is required",
            });
        }

        // Find template
        const template = await models.EmailTemplate.findOne({
            where: { id: templateId },
        });

        if (!template) {
            return res.status(404).json({
                success: false,
                message: "Template not found",
            });
        }

        // Delete template
        await template.destroy();

        return res.status(200).json({
            success: true,
            message: "Template deleted successfully",
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const sendEmail = async (req, res) => {
    try {
        const { userId } = req.user;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "User id not provided",
            });
        }
        if (req.user.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        const { userIds, templateId, personalizedData } = req.body;
        if (!userIds || !templateId) {
            return res.status(400).json({
                success: false,
                message: "User ids and template id must be provided",
            });
        }

        const template = await models.EmailTemplate.findOne({
            where: { id: templateId },
        });
        if (!template) {
            return res.status(404).json({
                success: false,
                message: "Template not found",
            });
        }

        const users = await models.User.findAll({
            where: {
                id: {
                    [Op.in]: userIds,
                },
            },
            include: [
                {
                    model: models.Customer,
                    required: false,
                },
            ],
        });
        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Users not found",
            });
        }

        // BUG 5 FIX: Track sent emails in SystemEmail table
        const emailResults = { success: 0, failed: 0 };

        // If personalizedData is provided, prepare personalized emails
        if (personalizedData && Object.keys(personalizedData).length > 0) {
            const personalizedEmails = [];

            for (const odUserId of userIds) {
                const user = users.find(u => u.id === parseInt(odUserId));
                if (!user) continue;

                const userPersonalizedData = personalizedData[odUserId];
                if (!userPersonalizedData) continue;

                // Create personalized subject and body
                let userSubject = template.subject;
                let userBody = template.body;

                const normalizePlaceholder = (placeholder) => placeholder.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
                const replacePlaceholders = (text, data) => {
                    if (!text) return text;
                    return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, rawKey) => {
                        const key = normalizePlaceholder(rawKey);
                        return data[key] !== undefined && data[key] !== null ? data[key] : match;
                    });
                };

                const placeholders = {
                    name: userPersonalizedData.name || '',
                    firstname: userPersonalizedData.firstName || '',
                    lastname: userPersonalizedData.lastName || '',
                    email: userPersonalizedData.email || user.email || '',
                    phone: userPersonalizedData.phone || '',
                    customerid: userPersonalizedData.customerId || '',
                    filenumber: userPersonalizedData.fileNumber || '',
                    address: userPersonalizedData.address || '',
                    city: userPersonalizedData.city || '',
                    state: userPersonalizedData.state || '',
                    zip: userPersonalizedData.zip || '',
                    clientname: userPersonalizedData.name || '',
                    companyname: 'TruNorth Debt Solutions',
                    company: 'TruNorth Debt Solutions',
                    yourname: userPersonalizedData.name || 'TruNorth Agent',
                    yourrole: 'Customer Support',
                    supportemail: process.env.SUPPORT_EMAIL || 'support@trunorth.com',
                    currentdate: new Date().toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    }),
                    today: new Date().toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    })
                };

                // Replace placeholders
                userSubject = replacePlaceholders(userSubject, placeholders);
                userBody = replacePlaceholders(userBody, placeholders);

                personalizedEmails.push({
                    userId: user.id,
                    email: userPersonalizedData.email || user.email,
                    subject: userSubject,
                    body: userBody,
                    userData: userPersonalizedData
                });
            }

            // Use the new bulk personalized email method
            const results = await emailer.sendBulkPersonalizedEmails(personalizedEmails, templateId);
            emailResults.success = results.success;
            emailResults.failed = results.failed;

            // BUG 5 FIX: Create SystemEmail records for each email, marking failures correctly
            for (const emailData of personalizedEmails) {
                try {
                    const sentObj = results.sentEmails?.find(s => s.email === emailData.email);
                    await models.SystemEmail.create({
                        userId: emailData.userId,
                        emailTemplateId: templateId,
                        receiverEmail: emailData.email,
                        subject: emailData.subject,
                        status: sentObj ? 'sent' : 'failed',
                        sentAt: new Date(),
                        messageId: sentObj?.messageId || null
                    });
                } catch (recordErr) {
                    console.error(`Failed to create SystemEmail record for ${emailData.email}:`, recordErr.message);
                }
            }
        } else {
            // Use the original method (with Customer data)
            const results = await emailer.sendBulkEmail(users, template);
            emailResults.success = results.success;
            emailResults.failed = results.failed;

            // BUG 5 FIX: Create SystemEmail records for each user
            for (const user of users) {
                try {
                    const sentObj = results.sentEmails?.find(s => s.email === user.email);
                    await models.SystemEmail.create({
                        userId: user.id,
                        emailTemplateId: templateId,
                        receiverEmail: user.email,
                        subject: template.subject,
                        status: sentObj ? 'sent' : 'failed',
                        sentAt: new Date(),
                        messageId: sentObj?.messageId || null
                    });
                } catch (recordErr) {
                    console.error(`Failed to create SystemEmail record for ${user.email}:`, recordErr.message);
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: `Email sent successfully. ${emailResults.success} sent, ${emailResults.failed} failed.`,
        });
    } catch (err) {
        console.error('Error in sendEmail:', err);
        return res.status(500).json({
            success: false,
            message: `Server error : ${err.message}`,
        });
    }
};

const getEmailHistory = async (req, res) => {
    try {
        if (req.user.role !== "admin") {
            return res.status(401).json({ success: false, message: "Unauthorized!" });
        }

        const { page = 1, limit = 20, search = "" } = req.query;
        const offset = (page - 1) * limit;

        const { Op } = require('sequelize');

        // Build include conditions
        const userInclude = {
            model: models.User,
            attributes: ["id", "email"],
            required: true,
        };

        const templateInclude = {
            model: models.EmailTemplate,
            attributes: ["id", "name", "subject", "body"],
            required: true,
        };

        // If search exists, add conditions to user include
        if (search) {
            userInclude.where = {
                email: { [Op.like]: `%${search}%` }
            };
        }

        const { count, rows: emails } = await models.SystemEmail.findAndCountAll({
            include: [userInclude, templateInclude],
            order: [["createdAt", "DESC"]],
            // limit: parseInt(limit),
            // offset: parseInt(offset),
            distinct: true,
        });

        res.status(200).json({
            success: true,
            emails,
            total: count,
            // totalPages: Math.ceil(count / limit),
            // currentPage: parseInt(page),
        });
    } catch (error) {
        console.error("Error fetching email history:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getProfile = async (req, res) => {
    try {
        const { userId } = req.user;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "User id is missing",
            });
        }
        const user = await models.User.findOne({ where: { id: userId }, attributes: { exclude: ['password'] } });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }
        return res.status(200).json({
            success: true,
            message: "Profile retrieved successfully",
            data: user,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error : ${err.message}`,
        });
    }
}

const updateProfile = async (req, res) => {
    try {
        const { userId } = req.user;
        const { password, confirmPassword } = req.body;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "User id is missing",
            });
        }
        const user = await models.User.findOne({ where: { id: userId } });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }
        const updates = {};
        if (password) {
            if (password !== confirmPassword) {
                return res.status(400).json({
                    success: false,
                    message: "Password and confirm password do not match",
                });
            }
            if (password.length < 8) {
                return res.status(400).json({
                    success: false,
                    message: "Password must be at least 8 characters long",
                });
            }
            const hashedPassword = await bcrypt.hash(password, 10);
            updates.password = hashedPassword;
        }
        await user.update(updates);
        return res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: user,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error : ${err.message}`,
        });
    }
};

const updateCustomerProfile = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized, due to missing id",
            });
        }

        const {
            FirstName,
            MiddleName,
            LastName,
            PrimaryPhone,
            WorkPhone,
            SpouseWorkPhone,
            Address,
            City,
            State,
            Zip,
            // REMOVED: email
            customerId,
        } = req.body;

        // Find the customer
        const customer = await models.Customer.findOne({
            where: { id: customerId },
        });

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        // Object to store updates
        const updates = {};
        const validationErrors = [];

        // Validation helper function
        const validatePhone = (phone, fieldName) => {
            if (phone) {
                const digitsOnly = phone.replace(/\D/g, "");

                // 9-12 digits, starts with 2-9
                if (!/^[1-9]\d{8,11}$/.test(digitsOnly)) {
                    validationErrors.push(`${fieldName} must be 9-12 digits and start with 1-9`);
                    return;
                }

                // Optional: Additional US/Canada validation for 10-digit numbers
                if (digitsOnly.length === 10) {
                    const areaCode = digitsOnly.substring(0, 3);
                    const exchangeCode = digitsOnly.substring(3, 6);
                    if (!/^[2-9]\d{2}$/.test(areaCode) || !/^[2-9]\d{2}$/.test(exchangeCode)) {
                        validationErrors.push(`${fieldName} has invalid area/exchange code`);
                        return;
                    }
                }

                updates[fieldName] = digitsOnly;
            }
        };

        const validateZip = (zip) => {
            if (zip) {
                const zipRegex = /^\d{5}(-\d{4})?$/;
                if (!zipRegex.test(zip)) {
                    validationErrors.push("Zip code must be in format 12345 or 12345-6789");
                }
            }
        };

        // Required fields validation
        if (FirstName !== undefined) {
            if (!FirstName || FirstName.trim() === "") {
                validationErrors.push("First name is required");
            } else if (FirstName.length < 2) {
                validationErrors.push("First name must be at least 2 characters long");
            } else {
                updates.FirstName = FirstName.trim();
            }
        }
        // Optional fields validation
        if (MiddleName !== undefined && MiddleName !== null && MiddleName !== "") {
            updates.MiddleName = MiddleName.trim();
        }
        if (LastName !== undefined) {
            if (!LastName || LastName.trim() === "") {
                validationErrors.push("Last name is required");
            } else if (LastName.length < 2) {
                validationErrors.push("Last name must be at least 2 characters long");
            } else {
                updates.LastName = LastName.trim();
            }
        }

        if (Address !== undefined) {
            if (!Address || Address.trim() === "") {
                validationErrors.push("Address is required");
            } else if (Address.length < 5) {
                validationErrors.push("Address must be at least 5 characters long");
            } else {
                updates.Address = Address.trim();
            }
        }

        if (PrimaryPhone !== undefined) {
            if (!PrimaryPhone || PrimaryPhone.trim() === "") {
                validationErrors.push("Primary phone is required");
            } else {
                validatePhone(PrimaryPhone, "Primary phone");
                updates.PrimaryPhone = PrimaryPhone.trim();
            }
        }

        if (City !== undefined && City !== null && City !== "") {
            if (City.length < 2) {
                validationErrors.push("City must be at least 2 characters long");
            } else {
                updates.City = City.trim();
            }
        }

        if (State !== undefined && State !== null && State !== "") {
            if (State.length < 2) {
                validationErrors.push("State must be at least 2 characters long");
            } else {
                updates.State = State.trim();
            }
        }

        if (Zip !== undefined && Zip !== null && Zip !== "") {
            validateZip(Zip);
            updates.Zip = Zip.trim();
        }

        if (WorkPhone !== undefined && WorkPhone !== null && WorkPhone !== "") {
            validatePhone(WorkPhone, "Work phone");
            updates.WorkPhone = WorkPhone.trim();
        }

        if (SpouseWorkPhone !== undefined && SpouseWorkPhone !== null && SpouseWorkPhone !== "") {
            validatePhone(SpouseWorkPhone, "Spouse work phone");
            updates.SpouseWorkPhone = SpouseWorkPhone.trim();
        }

        // REMOVED: Email update section entirely

        // Check if there are any validation errors
        if (validationErrors.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Validation errors",
                errors: validationErrors,
            });
        }

        // Check if there are any updates to make
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No updates provided to change",
            });
        }

        // Perform updates - only customer updates now
        if (Object.keys(updates).length > 0) {
            await customer.update(updates);
        }

        // Get updated customer data
        const updatedCustomer = await models.Customer.findOne({
            where: { id: customerId },
            include: [
                {
                    model: models.User,
                    attributes: ["id", "email"], // Still include email for display
                },
            ],
        });

        return res.status(200).json({
            success: true,
            message: "Customer updated successfully",
            data: updatedCustomer,
        });
    } catch (err) {
        console.error("Update profile error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const deleteCustomer = async (req, res) => {
    try {
        const { userId } = req.user;

        // Verify admin
        const admin = await models.User.findOne({
            where: { id: userId, role: "admin" },
        });

        if (!admin) {
            return res.status(403).json({
                success: false,
                message: "Access denied. Admin only.",
            });
        }

        const { customerId } = req.params;

        if (!customerId) {
            return res.status(400).json({
                success: false,
                message: "Customer ID is required",
            });
        }

        // Find the customer
        const customer = await models.Customer.findOne({
            where: { id: customerId },
        });

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        // First, delete all installments associated with the customer's debts
        // First, find all debts for this customer
        const debts = await models.Debt.findAll({
            where: { customerId: customerId },
        });

        // Delete installments for each debt
        for (const debt of debts) {
            await models.Installment.destroy({
                where: { debtId: debt.id }  // Assuming debtId is the foreign key in Installments
            });
        }

        // Then delete the debts
        await models.Debt.destroy({ where: { customerId: customerId } });

        // Then delete the customer
        await customer.destroy();

        // Finally delete the user account
        await models.User.destroy({ where: { id: customer.userId } });

        return res.status(200).json({
            success: true,
            message: "Customer deleted successfully",
        });
    } catch (err) {
        console.error("Delete customer error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const previewAudienceCount = async (req, res) => {
    try {
        const admin = await models.User.findOne({ where: { id: req.user.userId, role: "admin" } });
        if (!admin) return res.status(403).json({ success: false, message: "Access denied." });

        const { audience } = req.query;
        if (!audience) return res.json({ success: true, count: 0 });

        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const audienceLower = audience.toLowerCase();
        const userIds = new Set();

        if (audienceLower.includes('overdue')) {
            const debts = await models.Debt.findAll({
                where: { status: 'pending' },
                include: [{ model: models.Customer, required: true, include: [{ model: models.User, required: true, attributes: ['id'] }] }]
            });
            debts.forEach(d => {
                const user = d.Customer?.User || d.Customer?.user;
                if (user) userIds.add(user.id);
            });
        } else if (audienceLower.match(/\d+/)) {
            const days = parseInt(audienceLower.match(/\d+/)[0], 10);
            const cutoff = new Date(now.getTime() + days * 86400000);
            cutoff.setHours(23, 59, 59, 999);
            const insts = await models.Installment.findAll({
                where: { status: 'pending', dueDate: { [Op.between]: [now, cutoff] } },
                include: [{ model: models.User, required: true, attributes: ['id'], include: [{ model: models.Customer, required: true }] }]
            });
            insts.forEach(i => {
                const user = i.User || i.user;
                if (user) userIds.add(user.id);
            });
        } else {
            const debts = await models.Debt.findAll({
                where: { status: { [Op.ne]: 'paid' } },
                include: [{ model: models.Customer, required: true, include: [{ model: models.User, required: true, attributes: ['id'] }] }]
            });
            debts.forEach(d => {
                const user = d.Customer?.User || d.Customer?.user;
                if (user) userIds.add(user.id);
            });
        }

        return res.json({ success: true, count: userIds.size });
    } catch (err) {
        console.error("previewAudienceCount error:", err);
        return res.status(500).json({ success: false, count: 0, message: err.message });
    }
};

const previewAudienceList = async (req, res) => {
    try {
        const admin = await models.User.findOne({ where: { id: req.user.userId, role: "admin" } });
        if (!admin) return res.status(403).json({ success: false, message: "Access denied." });

        const { audience } = req.query;
        if (!audience) return res.json({ success: true, data: [] });

        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const audienceLower = audience.toLowerCase();
        const userMap = {};

        if (audienceLower.includes('overdue')) {
            const matchingDebts = await models.Debt.findAll({
                where: { status: 'pending' },
                include: [{ model: models.Customer, required: true, include: [{ model: models.User, required: true, attributes: ['id', 'email'] }] }]
            });
            for (const debt of matchingDebts) {
                const customer = debt.Customer || debt.customer;
                const user = customer?.User || customer?.user;
                if (user && user.email && !userMap[user.id]) {
                    const fullName = `${customer.FirstName || ''} ${customer.LastName || ''}`.trim();
                    userMap[user.id] = { id: user.id, email: user.email, name: fullName };
                }
            }
        } else if (audienceLower.match(/\d+/)) {
            const days = parseInt(audienceLower.match(/\d+/)[0], 10);
            const cutoff = new Date(now.getTime() + days * 86400000);
            cutoff.setHours(23, 59, 59, 999);

            const insts = await models.Installment.findAll({
                where: { status: 'pending', dueDate: { [Op.between]: [now, cutoff] } },
                include: [{ model: models.User, required: true, attributes: ['id', 'email'], include: [{ model: models.Customer, required: true }] }]
            });
            for (const i of insts) {
                const user = i.User || i.user;
                const customer = user?.Customer || user?.customer;
                if (user && user.email && customer && !userMap[user.id]) {
                    const fullName = `${customer.FirstName || ''} ${customer.LastName || ''}`.trim();
                    userMap[user.id] = { id: user.id, email: user.email, name: fullName };
                }
            }
        } else {
            const matchingDebts = await models.Debt.findAll({
                where: { status: { [Op.ne]: 'paid' } },
                include: [{ model: models.Customer, required: true, include: [{ model: models.User, required: true, attributes: ['id', 'email'] }] }]
            });
            for (const debt of matchingDebts) {
                const customer = debt.Customer || debt.customer;
                const user = customer?.User || customer?.user;
                if (user && user.email && !userMap[user.id]) {
                    const fullName = `${customer.FirstName || ''} ${customer.LastName || ''}`.trim();
                    userMap[user.id] = { id: user.id, email: user.email, name: fullName };
                }
            }
        }

        const users = Object.values(userMap);
        return res.json({ success: true, data: users });
    } catch (err) {
        console.error('previewAudienceList error:', err);
        return res.status(500).json({ success: false, data: [], message: err.message });
    }
};

const createCampaign = async (req, res) => {
    try {
        const { userId } = req.user;
        const admin = await models.User.findOne({ where: { id: userId, role: "admin" } });
        if (!admin) return res.status(403).json({ success: false, message: "Access denied." });

        const { name, audience, templateId, deliveryMode, scheduledDate, scheduledTime } = req.body;

        if (!name || !audience || !templateId) {
            return res.status(400).json({ success: false, message: "Name, audience, and templateId are required." });
        }

        // ── 1. Resolve the EmailTemplate ─────────────────────────────────────
        const template = await models.EmailTemplate.findByPk(templateId);
        // Debug: log template used when creating campaign to help trace template mismatches
        try {
            console.log(`📨 [createCampaign] Using templateId=${templateId} -> dbId=${template?.id} subject="${template?.subject || ''}" bodyPreview="${(template?.body || '').toString().replace(/\n/g, ' ').slice(0, 200)}"`);
        } catch (logErr) {
            console.warn('📨 [createCampaign] Failed to log template preview:', logErr.message);
        }
        if (!template) {
            return res.status(404).json({ success: false, message: "Template not found." });
        }

        // ── 2. Build Audience Filter based on EXACT Dashboard Mapping ────────
        const now = new Date();
        now.setHours(0, 0, 0, 0); // normalize "today" exactly like the dashboard does

        const audienceLower = audience.toLowerCase();
        const userMap = {};

        if (audienceLower.includes('overdue')) {
            // Dashboard's "Overdue Accounts" table strictly queries Debt with status = 'pending'
            const matchingDebts = await models.Debt.findAll({
                where: { status: 'pending' },
                include: [{
                    model: models.Customer,
                    required: true,
                    include: [{
                        model: models.User,
                        required: true,
                        attributes: ['id', 'email'],
                    }]
                }]
            });

            for (const debt of matchingDebts) {
                const customer = debt.Customer || debt.customer;
                const user = customer?.User || customer?.user;
                if (user && user.email && !userMap[user.id]) {
                    const fullName = `${customer.FirstName || ''} ${customer.LastName || ''}`.trim();
                    userMap[user.id] = {
                        id: user.id, email: user.email, Customer: customer,
                        personalizedData: {
                            name: fullName, firstName: customer.FirstName || '', lastName: customer.LastName || '',
                            email: user.email, phone: customer.PrimaryPhone || '', customerId: customer.id,
                            fileNumber: customer.FileNumber || '', address: customer.Address || '', city: customer.City || '',
                            state: customer.State || '', zip: customer.Zip || '', clientName: fullName,
                        }
                    };
                }
            }

        } else if (audienceLower.match(/\d+/)) {
            // Dashboard's "Upcoming Reminders" strictly queries Installments.dueDate
            const daysOffset = parseInt(audienceLower.match(/\d+/)[0], 10);
            const cutoff = new Date(now.getTime() + daysOffset * 24 * 60 * 60 * 1000);
            cutoff.setHours(23, 59, 59, 999);
            cutoff.setHours(23, 59, 59, 999);

            const matchingInstallments = await models.Installment.findAll({
                where: { status: 'pending', dueDate: { [Op.between]: [now, cutoff] } },
                include: [{
                    model: models.User,
                    required: true,
                    attributes: ['id', 'email'],
                    include: [{
                        model: models.Customer,
                        required: true
                    }]
                }]
            });

            for (const inst of matchingInstallments) {
                const user = inst.User || inst.user;
                const customer = user?.Customer || user?.customer;
                if (user && user.email && customer && !userMap[user.id]) {
                    const fullName = `${customer.FirstName || ''} ${customer.LastName || ''}`.trim();
                    userMap[user.id] = {
                        id: user.id, email: user.email, Customer: customer,
                        personalizedData: {
                            name: fullName, firstName: customer.FirstName || '', lastName: customer.LastName || '',
                            email: user.email, phone: customer.PrimaryPhone || '', customerId: customer.id,
                            fileNumber: customer.FileNumber || '', address: customer.Address || '', city: customer.City || '',
                            state: customer.State || '', zip: customer.Zip || '', clientName: fullName,
                        }
                    };
                }
            }

        } else {
            // Fallback: Just query all customers with un-paid debts
            const matchingDebts = await models.Debt.findAll({
                where: { status: { [Op.ne]: 'paid' } },
                include: [{
                    model: models.Customer, required: true,
                    include: [{ model: models.User, required: true, attributes: ['id', 'email'] }]
                }]
            });
            for (const debt of matchingDebts) {
                const customer = debt.Customer || debt.customer;
                const user = customer?.User || customer?.user;
                if (user && user.email && !userMap[user.id]) {
                    const fullName = `${customer.FirstName || ''} ${customer.LastName || ''}`.trim();
                    userMap[user.id] = {
                        id: user.id, email: user.email, Customer: customer,
                        personalizedData: {
                            name: fullName, firstName: customer.FirstName || '', lastName: customer.LastName || '',
                            email: user.email, phone: customer.PrimaryPhone || '', customerId: customer.id,
                            fileNumber: customer.FileNumber || '', address: customer.Address || '', city: customer.City || '',
                            state: customer.State || '', zip: customer.Zip || '', clientName: fullName,
                        }
                    };
                }
            }
        }

        const targetUsers = Object.values(userMap);
        const recipientsCount = targetUsers.length;

        // ── 4. Parse Scheduled Date ────────────────────────────────────────────
        let parsedDate = null;
        if (deliveryMode === 'schedule' && scheduledDate && scheduledTime) {
            // Combine date + time and interpret as LOCAL server time
            // Using a robust construction to avoid UTC interpretation issues
            const [year, month, day] = scheduledDate.split('-').map(Number);
            const [hours, minutes] = scheduledTime.split(':').map(Number);
            parsedDate = new Date(year, month - 1, day, hours, minutes, 0, 0);

            if (isNaN(parsedDate.getTime())) {
                return res.status(400).json({ success: false, message: 'Invalid scheduled date or time.' });
            }

            if (parsedDate <= new Date()) {
                return res.status(400).json({ success: false, message: 'Scheduled time must be in the future.' });
            }

            console.log(`⏰ Campaign "${name}" scheduled for: ${parsedDate.toLocaleString()} (server local time)`);
        }

        // ── 5. Save Campaign Record ────────────────────────────────────────────
        const campaignStatus = deliveryMode === 'immediate' ? 'Sent' : 'Scheduled';
        const campaign = await models.Campaign.create({
            name,
            audience,
            templateId,
            deliveryMode,
            scheduledDate: parsedDate,
            recipientsCount,
            status: campaignStatus,
        });

        // ── 6. Log each target email into SystemEmail table so tracking exists ─────────
        if (targetUsers.length > 0) {
            const systemEmailRecords = targetUsers.map(u => ({
                userId: u.id,
                emailTemplateId: templateId,
                campaignId: campaign.id,
                receiverEmail: u.email,
                subject: template.subject,
                body: template.body,
                status: 'pending',
                sentAt: null,
            }));
            await models.SystemEmail.bulkCreate(systemEmailRecords, { ignoreDuplicates: true });
        }

        // ── 7. Send Emails Immediately if deliveryMode === 'immediate' ─────────
        let emailResults = null;
        if (deliveryMode === 'immediate' && targetUsers.length > 0) {
            console.log(`📢 Campaign "${name}" -> sending to ${targetUsers.length} users`);
            emailResults = await emailer.sendBulkEmail(targetUsers, {
                subject: template.subject,
                body: template.body,
            });

            // Update records for successful and failed sends
            if (emailResults?.sentEmails) {
                for (const sentObj of emailResults.sentEmails) {
                    try {
                        await models.SystemEmail.update(
                            { status: 'sent', sentAt: new Date(), messageId: sentObj.messageId },
                            { where: { campaignId: campaign.id, receiverEmail: sentObj.email } }
                        );
                    } catch (err) {
                        console.error('Failed to update SystemEmail with messageId:', err);
                    }
                }
            }

            if (emailResults?.errors) {
                for (const errorObj of emailResults.errors) {
                    try {
                        await models.SystemEmail.update(
                            { status: 'failed', sentAt: new Date() },
                            { where: { campaignId: campaign.id, receiverEmail: errorObj.email } }
                        );
                    } catch (err) {
                        console.error('Failed to update SystemEmail failed status:', err);
                    }
                }
            }

            // If no emails succeeded, mark the campaign as Failed. Otherwise keep Sent.
            if (emailResults?.success === 0) {
                await campaign.update({ status: 'Failed' });
            }
        }

        return res.status(201).json({
            success: true,
            message: `Campaign created. ${recipientsCount} recipients matched for audience "${audience}".`,
            data: campaign,
            recipientsCount,
            emailResults,
        });

    } catch (err) {
        console.error("Error creating campaign:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getCampaignById = async (req, res) => {
    try {
        if (req.user.role !== "admin") return res.status(403).json({ success: false, message: "Access denied." });

        const { id } = req.params;
        const campaign = await models.Campaign.findByPk(id, {
            include: [{ model: models.EmailTemplate, attributes: ['name', 'subject', 'body'] }]
        });

        if (!campaign) {
            return res.status(404).json({ success: false, message: "Campaign not found" });
        }

        const systemEmails = await models.SystemEmail.findAll({
            where: { campaignId: id },
            include: [{
                model: models.User,
                attributes: ['id', 'email'],
                include: [{
                    model: models.Customer,
                    attributes: ['FirstName', 'LastName']
                }]
            }],
            order: [['createdAt', 'DESC']]
        });

        // Shape response and compute metrics
        const recipients = systemEmails.map(se => {
            const customer = se.User?.Customer || se.user?.Customer || se.user?.customer || se.User?.customer;
            const fullName = customer ? `${customer.FirstName || ''} ${customer.LastName || ''}`.trim() : 'Unknown User';
            const sentDate = se.sentAt || se.createdAt || null;
            const formattedDate = sentDate
                ? new Date(sentDate).toLocaleDateString('en-US', { day: '2-digit', month: 'short' })
                : 'Pending';
            let recipientStatus = 'Not Delivered';
            if (se.status === 'pending') recipientStatus = 'Scheduled';
            else if (Number(se.opens || 0) > 0) recipientStatus = 'Open';
            else if (se.status === 'sent' || se.status === 'delivered') recipientStatus = 'Delivered';
            else if (se.status === 'failed') recipientStatus = 'Failed';
            else if (se.status === 'unsubscribed') recipientStatus = 'Unsubscribed';

            return {
                id: se.id,
                name: fullName,
                email: se.receiverEmail,
                date: formattedDate,
                status: recipientStatus,
                click: (se.clicks && se.clicks > 0) ? 'Yes' : 'No',
                open: (se.opens && se.opens > 0) ? 'Yes' : 'No'
            };
        });

        // Aggregate metrics
        const totalRecipients = Number(campaign.recipientsCount) || systemEmails.length;
        const totalOpens = systemEmails.reduce((acc, s) => acc + (Number(s.opens) || 0), 0);
        const totalClicks = systemEmails.reduce((acc, s) => acc + (Number(s.clicks) || 0), 0);
        const openedCount = systemEmails.filter(se => Number(se.opens || 0) > 0).length;
        const openRate = sanitizePercentString(totalRecipients > 0 ? Math.round((openedCount / totalRecipients) * 100) : 0);

        const deliveredCount = recipients.filter(r => ['Delivered', 'Open'].includes(r.status)).length;
        const failedCount = recipients.filter(r => r.status === 'Failed').length;

        let overallCampaignStatus = campaign.status || 'Scheduled';
        if (totalRecipients > 0 && openedCount === totalRecipients) {
            overallCampaignStatus = 'Open';
        } else if (totalRecipients > 0 && deliveredCount > 0) {
            overallCampaignStatus = 'Delivered';
        } else if (totalRecipients > 0 && failedCount === totalRecipients) {
            overallCampaignStatus = 'Failed';
        }

        const templateName = campaign.EmailTemplate?.name || null;
        const templateSubject = campaign.EmailTemplate?.subject || null;
        const templateBody = campaign.EmailTemplate?.body || null;

        // Return enriched campaign object for frontend convenience
        return res.json({
            success: true,
            data: {
                ...campaign.toJSON(),
                status: overallCampaignStatus,
                template: templateName,
                templateSubject,
                templateBody,
                recipients,
                opens: totalOpens,
                clicks: totalClicks,
                openRate
            }
        });

    } catch (err) {
        console.error("Error fetching campaign details:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── Audience Member Detail (for eye-icon side drawer) ──────────────────────
const getAudienceMemberDetail = async (req, res) => {
    try {
        if (req.user.role !== "admin") return res.status(403).json({ success: false, message: "Access denied." });

        const { userId } = req.params;

        // Get the user with their customer + debt profile
        const user = await models.User.findOne({
            where: { id: userId },
            attributes: ['id', 'email'],
            include: [{
                model: models.Customer,
                attributes: ['id', 'FirstName', 'LastName', 'FileNumber', 'PrimaryPhone', 'userId'],
                include: [{
                    model: models.Debt,
                    attributes: ['id', 'AccountNumber', 'OriginalBalance', 'currentBalance', 'DatePlaced', 'dateChargedOff', 'status'],
                    limit: 1,
                    order: [['createdAt', 'DESC']]
                }]
            }]
        });

        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        const customer = user.Customer || user.customer;
        const debt = customer?.Debts?.[0] || customer?.debts?.[0];

        // Get all campaign emails sent to this user
        const emailHistory = await models.SystemEmail.findAll({
            where: { userId, campaignId: { [Op.ne]: null } },
            include: [{
                model: models.Campaign,
                attributes: ['id', 'name', 'audience']
            }],
            order: [['createdAt', 'DESC']]
        });

        const profile = {
            userId: user.id,
            email: user.email,
            name: customer ? `${customer.FirstName || ''} ${customer.LastName || ''}`.trim() : 'Unknown',
            accountNo: debt?.AccountNumber || customer?.FileNumber || `MRA-${user.id}`,
            loanAmount: parseFloat(debt?.OriginalBalance || 0),
            outstandingAmount: parseFloat(debt?.currentBalance || 0),
            dueDate: debt?.dateChargedOff || debt?.DatePlaced || null,
        };

        const emailActivity = emailHistory.map(se => {
            const campaign = se.Campaign || se.campaign;
            const sentDateVal = se.sentAt || se.createdAt || null;
            const sentDate = sentDateVal
                ? new Date(sentDateVal).toLocaleDateString('en-US', { day: '2-digit', month: 'short' })
                : 'Pending';

            const openedFlag = Number(se.opens || 0) > 0 ? 'Yes' : 'No';
            const clickedFlag = Number(se.clicks || 0) > 0 ? 'Yes' : 'No';

            let statusLabel = 'Delivered';
            if (se.status === 'pending') statusLabel = 'Pending';
            else if (se.status === 'failed') statusLabel = 'Failed';
            else if (se.status === 'unsubscribed') statusLabel = 'Unsubscribed';
            else if (openedFlag === 'Yes') statusLabel = 'Open';

            return {
                id: se.id,
                campaignName: campaign?.name || '—',
                sentDate,
                clicked: clickedFlag,
                opened: openedFlag,
                status: statusLabel
            };
        });

        return res.json({ success: true, data: { profile, emailActivity } });
    } catch (err) {
        console.error("getAudienceMemberDetail error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── Delete Audience Member (removes their SystemEmail campaign records) ──────
const deleteAudienceMember = async (req, res) => {
    try {
        if (req.user.role !== "admin") return res.status(403).json({ success: false, message: "Access denied." });

        const { userId } = req.params;

        const deleted = await models.SystemEmail.destroy({
            where: { userId, campaignId: { [Op.ne]: null } }
        });

        if (deleted === 0) return res.status(404).json({ success: false, message: "No campaign records found for this user." });

        return res.json({ success: true, message: `Removed ${deleted} campaign email record(s) for user.` });
    } catch (err) {
        console.error("deleteAudienceMember error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getCampaignAudience = async (req, res) => {
    try {
        if (req.user.role !== "admin") return res.status(403).json({ success: false, message: "Access denied." });

        // Get all SystemEmails that were part of a campaign (campaignId is set)
        const sentEmails = await models.SystemEmail.findAll({
            where: { campaignId: { [Op.ne]: null } },
            include: [
                {
                    model: models.User,
                    attributes: ['id', 'email'],
                    include: [
                        {
                            model: models.Customer,
                            attributes: ['id', 'FirstName', 'LastName', 'FileNumber', 'userId'],
                            include: [
                                {
                                    model: models.Debt,
                                    attributes: ['id', 'AccountNumber', 'currentBalance', 'OriginalBalance', 'DatePlaced', 'status'],
                                    required: false,
                                    limit: 1,
                                    order: [['createdAt', 'DESC']]
                                }
                            ]
                        }
                    ]
                },
                {
                    model: models.Campaign,
                    attributes: ['id', 'name', 'audience', 'createdAt']
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        // Deduplicate by userId — keep the most recent send per user
        const seen = new Set();
        const uniqueRecords = [];
        for (const se of sentEmails) {
            const user = se.User || se.user;
            if (!user) continue;
            if (!seen.has(user.id)) {
                seen.add(user.id);
                uniqueRecords.push(se);
            }
        }

        const data = uniqueRecords.map(se => {
            const user = se.User || se.user;
            const customer = user?.Customer || user?.customer;
            const debt = customer?.Debts?.[0] || customer?.debts?.[0];
            const campaign = se.Campaign || se.campaign;

            const fullName = customer
                ? `${customer.FirstName || ''} ${customer.LastName || ''}`.trim()
                : 'Unknown';

            const amount = parseFloat(debt?.currentBalance || debt?.OriginalBalance || 0);
            const datePlaced = debt?.DatePlaced ? new Date(debt.DatePlaced) : null;
            const dueDateObj = datePlaced
                ? new Date(datePlaced.getTime() + 30 * 24 * 3600 * 1000)
                : null;
            const dueDateValue = dueDateObj
                ? `${dueDateObj.getFullYear()}-${String(dueDateObj.getMonth() + 1).padStart(2, '0')}-${String(dueDateObj.getDate()).padStart(2, '0')}`
                : null;
            const today = new Date();
            const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            const dueDateStart = dueDateObj
                ? new Date(dueDateObj.getFullYear(), dueDateObj.getMonth(), dueDateObj.getDate())
                : null;
            const daysLeft = dueDateStart
                ? Math.round((dueDateStart - todayStart) / (1000 * 60 * 60 * 24))
                : null;

            // Map email status
            let displayStatus = 'Delivered';
            if (se.status === 'pending') displayStatus = 'Pending';
            else if (se.status === 'failed') displayStatus = 'Failed';

            return {
                id: se.id,
                userId: user.id,
                customerId: customer?.id,
                name: fullName,
                email: se.receiverEmail,
                accountNo: debt?.AccountNumber || customer?.FileNumber || `MRA-${user.id}`,
                amount,
                dueDate: dueDateObj
                    ? dueDateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                    : '—',
                dueDateValue,
                dueInDays: daysLeft,
                dueIn: daysLeft !== null
                    ? (daysLeft < 0
                        ? `${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} overdue`
                        : daysLeft === 0
                            ? 'Today'
                            : `${daysLeft} day${daysLeft === 1 ? '' : 's'}`)
                    : '—',
                status: displayStatus,
                campaignName: campaign?.name || '—',
                campaignAudience: campaign?.audience || '—',
                sentAt: se.sentAt || se.createdAt
            };
        });

        return res.json({
            success: true,
            data,
            total: data.length,
            stats: {
                total: data.length,
                delivered: data.filter(d => d.status === 'Delivered').length,
                pending: data.filter(d => d.status === 'Pending').length,
                failed: data.filter(d => d.status === 'Failed').length,
            }
        });
    } catch (err) {
        console.error("getCampaignAudience error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getCampaigns = async (req, res) => {
    try {
        if (req.user.role !== "admin") return res.status(403).json({ success: false, message: "Access denied." });

        const { page = 1, limit = 10 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const { count, rows } = await models.Campaign.findAndCountAll({
            include: [{ model: models.EmailTemplate, attributes: ["name", "subject", "id"] }],
            order: [["createdAt", "DESC"]],
            limit: parseInt(limit),
            offset: offset,
        });

        const rowsWithStatus = await Promise.all(rows.map(async (campaign) => {
            const totalRecipients = Number(campaign.recipientsCount) || 0;
            let resolvedStatus = campaign.status || "Scheduled";

            if (totalRecipients > 0) {
                const [openedCount, deliveredCount, failedCount] = await Promise.all([
                    models.SystemEmail.count({ where: { campaignId: campaign.id, opens: { [Op.gt]: 0 } } }),
                    models.SystemEmail.count({ where: { campaignId: campaign.id, status: { [Op.in]: ["delivered", "sent"] } } }),
                    models.SystemEmail.count({ where: { campaignId: campaign.id, status: "failed" } }),
                ]);

                if (openedCount >= totalRecipients && totalRecipients > 0) {
                    resolvedStatus = "Open";
                } else if (failedCount === totalRecipients && totalRecipients > 0) {
                    resolvedStatus = "Failed";
                } else if ((deliveredCount > 0 || openedCount > 0) && totalRecipients > 0) {
                    resolvedStatus = "Delivered";
                }
            }

            return {
                ...campaign.toJSON(),
                status: resolvedStatus,
            };
        }));

        // Compute stats for all campaigns
        const allCampaigns = await models.Campaign.findAll({ attributes: ["status", "recipientsCount"] });

        let totalCampaignsCount = allCampaigns.length;
        let activeCampaignsCount = allCampaigns.filter(c => c.status === "Scheduled").length;
        let emailsSentCount = allCampaigns.reduce((acc, c) => acc + (["Sent", "Delivered", "Open"].includes(c.status) ? Number(c.recipientsCount || 0) : 0), 0);

        return res.status(200).json({
            success: true,
            data: rowsWithStatus,
            total: count,
            totalPages: Math.ceil(count / limit),
            stats: {
                totalCampaigns: totalCampaignsCount,
                activeCampaigns: activeCampaignsCount,
                emailsSent: emailsSentCount
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

const deleteCampaign = async (req, res) => {
    try {
        const { userId } = req.user;
        const admin = await models.User.findOne({ where: { id: userId, role: "admin" } });
        if (!admin) return res.status(403).json({ success: false, message: "Access denied." });

        const { id } = req.params;
        const campaign = await models.Campaign.findByPk(id);

        if (!campaign) {
            return res.status(404).json({ success: false, message: "Campaign not found" });
        }

        await campaign.destroy();
        return res.status(200).json({ success: true, message: "Campaign deleted successfully" });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getOperationsDashboard = async (req, res) => {
    try {
        if (req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Access denied." });
        }

        const { period = '9d' } = req.query;

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        const threeDaysFromNow = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
        const sevenDaysFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

        // ── 1. Email Stats (from SystemEmail) ──────────────────────────────
        const [totalEmailsSent, emailsSentYesterday, emailsSentToday] = await Promise.all([
            models.SystemEmail.count({ where: { sentAt: { [Op.ne]: null } } }),
            models.SystemEmail.count({ where: { sentAt: { [Op.gte]: yesterday, [Op.lt]: today } } }),
            models.SystemEmail.count({ where: { sentAt: { [Op.gte]: today } } }),
        ]);

        // ── 2. Campaign Stats ────────────────────────────────────────────
        const allCampaigns = await models.Campaign.findAll({
            attributes: ["id", "status", "recipientsCount", "audience", "name", "createdAt", "templateId", "openRate", "opens", "clicks"],
            order: [["createdAt", "DESC"]],
            include: [{ model: models.EmailTemplate, attributes: ["name"] }],
        });

        const recentCampaigns = await Promise.all(allCampaigns.slice(0, 5).map(async (c) => {
            const campaignId = c && c.id ? Number(c.id) : null;
            const recipients = Number(c?.recipientsCount) || 0;
            let status = (c?.status || "Scheduled").toString().trim();

            if (["open", "opened", "in progress", "in-progress", "in_progress"].includes(status.toLowerCase())) {
                status = "Open";
            } else if (["send", "sending", "sent", "success", "successful", "delivered", "delivery"].includes(status.toLowerCase())) {
                status = "Delivered";
            } else if (["failed", "fail", "not sent", "not_sent", "not-sent", "unsent", "error"].includes(status.toLowerCase())) {
                status = "Failed";
            } else if (["scheduled", "schedule", "pending"].includes(status.toLowerCase())) {
                status = "Scheduled";
            }

            let openedCount = 0;
            let failedCount = 0;
            let deliveredCount = 0;

            if (campaignId) {
                [openedCount, failedCount, deliveredCount] = await Promise.all([
                    models.SystemEmail.count({ where: { campaignId, opens: { [Op.gt]: 0 } } }),
                    models.SystemEmail.count({ where: { campaignId, status: "failed" } }),
                    models.SystemEmail.count({ where: { campaignId, status: { [Op.in]: ["delivered", "sent"] } } }),
                ]);
            }

            if (recipients > 0 && openedCount >= recipients) status = "Open";
            else if (recipients > 0 && failedCount === recipients) status = "Failed";
            else if (recipients > 0 && (deliveredCount > 0 || openedCount > 0)) status = "Delivered";

            const openedRecipients = campaignId ? await models.SystemEmail.count({ where: { campaignId, opens: { [Op.gt]: 0 } } }) : 0;
            const openRate = recipients > 0 ? formatPercent(Math.min(100, Math.round((openedRecipients / recipients) * 100))) : "0.0%";

            return {
                id: c?.id || null,
                name: c?.name || 'Unknown',
                audience: c?.audience || '—',
                template: c?.EmailTemplate?.name || 'Unknown',
                recipients,
                sentDate: c?.createdAt ? new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—',
                openRate,
                status,
            };
        }));

        // ── 3. Overdue / Upcoming Reminders (from Installments) ──────────
        const [duein3, duein7, duein30, overdue] = await Promise.all([
            models.Installment.count({
                where: { status: 'pending', dueDate: { [Op.between]: [today, threeDaysFromNow] } }
            }),
            models.Installment.count({
                where: { status: 'pending', dueDate: { [Op.between]: [today, sevenDaysFromNow] } }
            }),
            models.Installment.count({
                where: { status: 'pending', dueDate: { [Op.between]: [today, thirtyDaysFromNow] } }
            }),
            models.Installment.count({
                where: { status: 'pending', dueDate: { [Op.lt]: today } }
            }),
        ]);

        // ── 4. Overdue Accounts ──────────────────────────────────────────
        const overdueDebts = await models.Debt.findAll({
            where: { status: 'pending' },
            include: [
                {
                    model: models.Customer,
                    attributes: ["userId", "FirstName", "LastName"],
                    include: [{ model: models.User, attributes: ["id", "email"] }]
                }
            ],
            order: [["createdAt", "DESC"]],
            limit: 5,
        });

        const overdueAccounts = overdueDebts.map(d => ({
            userId: d.Customer?.userId || d.Customer?.User?.id || null,
            email: d.Customer?.User?.email || '',
            customer: `${d.Customer?.FirstName || ''} ${d.Customer?.LastName || ''}`.trim() || 'Unknown',
            accountNo: d.AccountNumber,
            amount: `$${parseFloat(d.currentBalance || d.OriginalBalance).toLocaleString()}`,
            datePlaced: d.DatePlaced
                ? new Date(d.DatePlaced).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
                : 'N/A',
            status: d.status === 'pending' ? 'Overdue' : 'Active',
        }));

        // ── 5. Recent Activity (from SystemEmail + Campaign + Templates) ─────────────
        const [recentEmails, recentTemplates] = await Promise.all([
            models.SystemEmail.findAll({
                where: { sentAt: { [Op.ne]: null } },
                attributes: ["subject", "sentAt", "status", "opens", "clicks"],
                order: [["sentAt", "DESC"]],
                limit: 3,
            }),
            models.EmailTemplate.findAll({
                attributes: ["name", "createdAt", "updatedAt"],
                order: [["updatedAt", "DESC"]],
                limit: 3,
            })
        ]);


        const recentCampaignActivity = allCampaigns.slice(0, 3).map(c => ({
            text: `Campaign "${c.name}" ${c.status}`,
            timestamp: new Date(c.createdAt).getTime(),
            time: timeAgo(c.createdAt),
        }));

        const recentEmailActivity = recentEmails.map(e => {
            const hasOpen = Number(e.opens || 0) > 0;
            const hasClick = Number(e.clicks || 0) > 0;
            const eventLabel = hasOpen ? 'Opened' : hasClick ? 'Clicked' : 'Sent';
            return {
                text: `Email ${eventLabel}: ${e.subject || 'No Subject'}`,
                timestamp: new Date(e.sentAt).getTime(),
                time: timeAgo(e.sentAt),
            };
        });

        const recentTemplateActivity = recentTemplates.map(t => {
            const isNew = Math.abs(new Date(t.createdAt).getTime() - new Date(t.updatedAt).getTime()) < 5000; // within 5 seconds means created
            return {
                text: `Template "${t.name}" ${isNew ? 'Created' : 'Updated'}`,
                timestamp: new Date(t.updatedAt).getTime(),
                time: timeAgo(t.updatedAt),
            };
        });

        const recentActivity = [...recentCampaignActivity, ...recentEmailActivity, ...recentTemplateActivity]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 5)
            .map(a => ({ text: a.text, time: a.time }));

        // ── 6. Total Debt Summary ────────────────────────────────────────
        const debtSummary = await models.Debt.findOne({
            attributes: [
                [models.sequelize.fn('COUNT', models.sequelize.col('id')), 'totalClients'],
                [models.sequelize.fn('SUM', models.sequelize.col('currentBalance')), 'totalDebt'],
            ],
            raw: true,
        });

        // ── 7. Email Performance Trend ─────────────────────
        const chartData = [];
        let days = 9;
        if (period === '7d') days = 7;
        else if (period === '14d') days = 14;
        else if (period === '30d') days = 30;

        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
            const nextD = new Date(d.getTime() + 24 * 60 * 60 * 1000);
            const daySent = await models.SystemEmail.count({
                where: { sentAt: { [Op.gte]: d, [Op.lt]: nextD } }
            });
            const dayOpened = await models.SystemEmail.sum('opens', {
                where: { sentAt: { [Op.gte]: d, [Op.lt]: nextD } }
            }) || 0;
            const dayClicked = await models.SystemEmail.sum('clicks', {
                where: { sentAt: { [Op.gte]: d, [Op.lt]: nextD } }
            }) || 0;

            chartData.push({
                date: d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }),
                sent: daySent,
                opened: dayOpened,
                clicked: dayClicked
            });
        }

        // Calculate Real Rates
        const totalTrackedEmails = await models.SystemEmail.count({ where: { status: { [Op.ne]: 'pending' } } });
        const failedEmails = await models.SystemEmail.count({ where: { status: 'failed' } });
        const deliveryRate = totalTrackedEmails > 0 ? formatPercent(((totalTrackedEmails - failedEmails) / totalTrackedEmails) * 100) : '0.0%';
        const bounceRate = totalTrackedEmails > 0 ? formatPercent((failedEmails / totalTrackedEmails) * 100) : '0.0%';

        const campaignsWithRecipients = allCampaigns.filter(c => Number(c.recipientsCount) > 0);
        let totalOpenPerc = 0;
        campaignsWithRecipients.forEach(c => {
            totalOpenPerc += calculateRate(c.opens || 0, c.recipientsCount || 0);
        });
        const avgOpenRate = campaignsWithRecipients.length > 0 ? formatPercent(totalOpenPerc / campaignsWithRecipients.length) : '0.0%';

        return res.status(200).json({
            success: true,
            data: {
                stats: {
                    emailsSent: totalEmailsSent,
                    emailsSentYesterday,
                    deliveryRate,
                    openRate: avgOpenRate,
                    bounceRate,
                },
                recentCampaigns,
                upcomingReminders: [
                    { title: 'Due in 3 days', sub: 'High urgency', count: duein3, color: '#ef4444' },
                    { title: 'Due in 7 days', sub: 'Medium urgency', count: duein7, color: '#f59e0b' },
                    { title: 'Due in 30 days', sub: 'Low urgency', count: duein30, color: '#10b981' },
                    { title: 'Overdue', sub: 'Critical', count: overdue, color: '#ef4444' },
                ],
                overdueAccounts,
                recentActivity,
                summary: {
                    totalClients: parseInt(debtSummary?.totalClients) || 0,
                    totalDebt: parseFloat(debtSummary?.totalDebt) || 0,
                },
                chartData,
            },
        });
    } catch (err) {
        console.error('getOperationsDashboard error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

function timeAgo(date) {
    if (!date) return 'Unknown';
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (mins > 0) return `${mins} min${mins > 1 ? 's' : ''} ago`;
    return 'Just now';
}

const getInsightsDashboard = async (req, res) => {
    try {
        if (req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Access denied." });
        }

        const { period = '30d' } = req.query;
        let dateFilter = {};
        const now = new Date();

        if (period === 'today') {
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            dateFilter = { [Op.gte]: todayStart };
        } else if (period === '7d') {
            dateFilter = { [Op.gte]: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
        } else if (period === '30d') {
            dateFilter = { [Op.gte]: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
        } else {
            // all time, no filter
            dateFilter = { [Op.ne]: null };
        }

        // 1. Deliverability Health (from SystemEmails)
        const totalEmails = await models.SystemEmail.count({
            where: {
                sentAt: dateFilter,
                status: { [Op.in]: ['sent', 'failed', 'delivered', 'unsubscribed'] }
            }
        });
        const failedEmails = await models.SystemEmail.count({
            where: {
                status: 'failed',
                sentAt: dateFilter
            }
        });

        let deliverability;
        if (totalEmails === 0) {
            deliverability = {
                rate: '0.0%',
                breakdown: [
                    { name: 'Delivered', value: 1, color: '#e2e8f0' }, // Dummy gray slice so it's not invisible
                    { name: 'Failed', value: 0, color: '#ef4444' }
                ]
            };
        } else {
            const successRate = ((totalEmails - failedEmails) / totalEmails * 100).toFixed(1);
            deliverability = {
                rate: `${successRate}%`,
                breakdown: [
                    { name: 'Delivered', value: totalEmails - failedEmails, color: '#22c55e' },
                    { name: 'Failed', value: failedEmails, color: '#ef4444' }
                ]
            };
        }

        // Fetch campaigns matching period
        const periodCampaigns = await models.Campaign.findAll({
            where: { createdAt: dateFilter },
            attributes: ["name", "audience", "recipientsCount", "opens", "clicks", "createdAt"],
            include: [{ model: models.EmailTemplate, attributes: ["id", "name"] }],
        });

        // 2. Audience Engagement (Aggregated by Audience)
        const audienceMap = {};
        periodCampaigns.forEach(c => {
            const aud = c.audience || 'General';
            const recipients = Number(c.recipientsCount) || 0;
            const openRate = recipients > 0 ? calculateRate(c.opens || 0, recipients) : 0;
            const clickRate = recipients > 0 ? calculateRate(c.clicks || 0, recipients) : 0;

            if (!audienceMap[aud]) {
                audienceMap[aud] = { seg: aud, rec: 0, totalOpen: 0, totalClick: 0, count: 0 };
            }
            audienceMap[aud].rec += recipients;
            audienceMap[aud].totalOpen += openRate;
            audienceMap[aud].totalClick += clickRate;
            audienceMap[aud].count++;
        });

        const audienceMetrics = Object.values(audienceMap).map(a => {
            const avgOpen = a.count > 0 ? Math.floor(a.totalOpen / a.count) : 0;
            const avgClick = a.count > 0 ? Math.floor(a.totalClick / a.count) : 0;
            return {
                seg: a.seg,
                rec: a.rec.toLocaleString(),
                open: avgOpen,
                click: avgClick,
                openCol: avgOpen >= 70 ? '#22c55e' : (avgOpen >= 40 ? '#f59e0b' : '#ef4444'),
                clickCol: avgClick >= 70 ? '#22c55e' : (avgClick >= 40 ? '#f59e0b' : '#ef4444')
            };
        });

        // 3. Top performing campaigns
        let campaignMetrics = periodCampaigns.map(c => {
            const recipients = Number(c.recipientsCount) || 0;
            const openRatePercentage = recipients > 0 ? calculateRate(c.opens || 0, recipients) : 0;
            const clickRatePercentage = recipients > 0 ? calculateRate(c.clicks || 0, recipients) : 0;
            return {
                camp: c.name,
                aud: c.audience || 'General',
                open: openRatePercentage,
                click: clickRatePercentage,
                openCol: openRatePercentage >= 70 ? '#22c55e' : (openRatePercentage >= 40 ? '#f59e0b' : '#ef4444'),
                clickCol: clickRatePercentage >= 70 ? '#22c55e' : (clickRatePercentage >= 40 ? '#f59e0b' : '#ef4444')
            };
        }).sort((a, b) => b.open - a.open).slice(0, 4);

        // 4. Template performance (Aggregated by EmailTemplate)
        const tmplMap = {};
        periodCampaigns.forEach(c => {
            const tName = c.EmailTemplate?.name || 'Unknown Template';
            const recipients = Number(c.recipientsCount) || 0;
            const openRate = recipients > 0 ? calculateRate(c.opens || 0, recipients) : 0;
            const clickRate = recipients > 0 ? calculateRate(c.clicks || 0, recipients) : 0;

            if (!tmplMap[tName]) tmplMap[tName] = { name: tName, campaigns: 0, totalOpen: 0, totalClick: 0 };
            tmplMap[tName].campaigns++;
            tmplMap[tName].totalOpen += openRate;
            tmplMap[tName].totalClick += clickRate;
        });

        let templatePerf = Object.values(tmplMap).map((t, idx) => {
            return {
                name: t.name,
                campaigns: t.campaigns,
                openRate: t.campaigns > 0 ? Math.floor(t.totalOpen / t.campaigns) : 0,
                clickRate: t.campaigns > 0 ? Math.floor(t.totalClick / t.campaigns) : 0,
                rank: idx
            };
        }).sort((a, b) => b.openRate - a.openRate).slice(0, 4);

        return res.status(200).json({
            success: true,
            data: {
                deliverability,
                audience: audienceMetrics,
                campaigns: campaignMetrics,
                templates: templatePerf
            }
        });

    } catch (err) {
        console.error('getInsightsDashboard error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getActivityLogs = async (req, res) => {
    try {
        if (req.user.role !== "admin") {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        // Fetch recent customers
        const recentCustomers = await models.Customer.findAll({
            attributes: ['id', 'FirstName', 'LastName', 'createdAt'],
            order: [['createdAt', 'DESC']],
            limit: 20
        });

        // Fetch recent deals
        const recentDeals = await models.Deal.findAll({
            attributes: ['id', 'status', 'proposedAmount', 'createdAt'],
            order: [['createdAt', 'DESC']],
            limit: 20
        });

        // Fetch recent payments
        const recentPayments = await models.PaymentHistory.findAll({
            attributes: ['id', 'amount', 'status', 'paymentType', 'createdAt'],
            order: [['createdAt', 'DESC']],
            limit: 20
        });

        // Format and merge all logs
        let logs = [];

        recentCustomers.forEach(c => {
            logs.push({
                id: `cust-${c.id}`,
                type: 'new_customer',
                title: 'New Client Registered',
                description: `${c.FirstName || ''} ${c.LastName || ''} joined the platform.`,
                timestamp: c.createdAt,
                timestampStr: new Date(c.createdAt).toLocaleString(),
                icon: 'user'
            });
        });

        recentDeals.forEach(d => {
            let statusText = d.status === 'accepted' ? 'Deal Accepted' :
                d.status === 'rejected' ? 'Deal Rejected' :
                    d.status === 'countered' ? 'Deal Countered' : 'New Deal Proposed';
            logs.push({
                id: `deal-${d.id}`,
                type: 'deal_update',
                title: statusText,
                description: `A deal was ${d.status}. Proposed Amount: $${d.proposedAmount}`,
                timestamp: d.createdAt,
                timestampStr: new Date(d.createdAt).toLocaleString(),
                icon: 'deal'
            });
        });

        recentPayments.forEach(p => {
            if (p.status === 'completed' || p.status === 'success') {
                logs.push({
                    id: `pay-${p.id}`,
                    type: 'payment',
                    title: 'Payment Received',
                    description: `A ${p.paymentType} payment of $${p.amount} was received successfully.`,
                    timestamp: p.createdAt,
                    timestampStr: new Date(p.createdAt).toLocaleString(),
                    icon: 'payment'
                });
            }
        });

        // Sort globally by timestamp, newest first
        logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Return top 50
        return res.status(200).json({
            success: true,
            data: logs.slice(0, 50)
        });

    } catch (err) {
        console.error("Error fetching activity logs:", err);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
};

module.exports = {
    dashboard,
    uploadExcel,
    getAllCustomers,
    dealsManager,
    getAllDeals,
    getDealDetails,
    getTemplateByName,
    createTemplate,
    sendEmail,
    getTemplateById,
    getDealHistory,
    getEmailHistory,
    clientProfile,
    deleteTemplate,
    getAllTemplates,
    updateTemplate,
    updateProfile, //  new
    getProfile,
    updateCustomerProfile,
    deleteCustomer,
    previewAudienceCount,
    previewAudienceList,
    createCampaign,
    getCampaignAudience,
    getAudienceMemberDetail,
    deleteAudienceMember,
    getCampaigns,
    getCampaignById,
    deleteCampaign,
    getOperationsDashboard,
    getInsightsDashboard,
    getActivityLogs,
};
