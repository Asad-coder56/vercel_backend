const models = require("../models/index");
const bcrypt = require("bcryptjs");
const { Op } = require("sequelize");
const emailer = require("../services/emailService");
const authorizeNet = require("../services/authorizeNetService");
require("dotenv").config();

const dashboard = async (req, res) => {
    try {
        const { userId } = req.user;

        // Get customer user
        const customerUser = await models.User.findOne({
            where: { id: userId, role: "customer" },
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
            unpaidDebtsTotal,
            dealsLastMonthData,
            acceptedDealsSavings,
            settlementRateData,
            lastMonthPayments,
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
                    userId: userId,
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
                where: { userId: userId },
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
                    userId: userId,
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
                    status: { [Op.ne]: "paid" }, // Only unpaid debts
                },
                attributes: [
                    [models.sequelize.fn("SUM", models.sequelize.col("OriginalBalance")), "totalUnpaidOriginal"],
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
                    userId: userId,
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
                        where: { userId: userId, status: "pending" },
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

const createDeal = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized, due to missing id",
            });
        }
        const { debtId, proposedAmount, clientNote } = req.body;
        const installments = await models.Installment.findOne({
            where: { debtId: debtId, status: { [Op.in]: ['pending', 'processing'] } },
        });
        if (installments) {
            return res.status(400).json({
                success: false,
                message: "Cannot create deal for debts with active installments",
            });
        }
        if (!debtId || !proposedAmount) {
            return res.status(400).json({
                success: false,
                message: "DebtId and Proposed Amount are required",
            });
        }

        // BUG 3 FIX: First find the customer, then verify debt belongs to them
        const customer = await models.Customer.findOne({ where: { userId: userId } });
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer profile not found"
            });
        }

        // BUG 3 FIX: Verify debt exists AND belongs to this customer
        const debt = await models.Debt.findOne({
            where: {
                id: debtId,
                customerId: customer.id  // Ensure debt belongs to this customer
            },
        });
        if (!debt) {
            return res.status(404).json({
                success: false,
                message: "Debt not found or does not belong to you",
            });
        }

        // BUG 3 FIX: Check debt status - can't create deal for paid/closed debts
        if (debt.status === 'paid' || debt.StatusType === 'Closed') {
            return res.status(400).json({
                success: false,
                message: "Cannot create deal for a paid or closed debt"
            });
        }

        // BUG 3 FIX: Check if there's already an active deal for this debt
        const existingDeal = await models.Deal.findOne({
            where: {
                debtId: debtId,
                status: { [Op.in]: ['pending', 'countered'] }
            }
        });
        if (existingDeal) {
            return res.status(400).json({
                success: false,
                message: "An active deal already exists for this debt"
            });
        }

        const parsedProposed = parseFloat(proposedAmount);
        const parsedOriginal = parseFloat(debt.OriginalBalance);

        if (isNaN(parsedProposed) || parsedProposed <= 0) {
            return res.status(400).json({
                success: false,
                message: "Proposed amount must be a positive number"
            });
        }

        if (parsedOriginal > 0 && parsedProposed > parsedOriginal) {
            return res.status(400).json({
                success: false,
                message: "Deal amount must be less than or equal to Original amount of the debt"
            });
        }

        const deal = await models.Deal.create({
            debtId,
            proposedAmount,
            clientNote: clientNote ? clientNote : "No note from client",
            customerUserId: userId,
        });
        const admin = await models.User.findOne({ where: { role: "admin" } });

        const data = {
            email: admin.email,
            body: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2 style="color:#2c3e50;">📄 New Deal Created</h2>

            <p>Hello Admin,</p>

            <p>A client has initiated a <strong>new deal</strong>.</p>

            <table style="border-collapse: collapse; width: 100%; margin-top: 15px;">
                <tr>
                    <td style="padding: 8px; border: 1px solid #ddd;"><strong>Client Name</strong></td>
                    <td style="padding: 8px; border: 1px solid #ddd;">${customer.FirstName} ${customer.LastName}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #ddd;"><strong>Deal ID</strong></td>
                    <td style="padding: 8px; border: 1px solid #ddd;">${deal.id}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #ddd;"><strong>Proposed Amount</strong></td>
                    <td style="padding: 8px; border: 1px solid #ddd;">$${deal.amount}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #ddd;"><strong>Status</strong></td>
                    <td style="padding: 8px; border: 1px solid #ddd;">${deal.status}</td>
                </tr>
            </table>

            <p style="margin-top: 20px;">
                Please log in to the admin panel to review and respond to this deal.
            </p>

            <p style="margin-top: 30px;">
                Regards,<br />
                <strong>TruNorth System</strong>
            </p>
        </div>
    `,
        };

        await emailer.sendDealEmail(data);

        return res.status(200).json({
            success: true,
            message: "Deal created successfully",
            data: deal,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error : ${err.message}`,
        });
    }
};

const buildAdminDealEmail = ({ action, deal, note, newAmount, currentCounter }) => {
    const customer = deal.Debt.Customer;
    const debtAmount = deal.Debt.OriginalBalance;

    let actionText = "";
    let details = "";

    if (action === "accept") {
        actionText = "✅ Deal Accepted by Customer";
        details = `
            <p><strong>Original Debt:</strong> $${debtAmount}</p>
            <p><strong>Your Counter Offer:</strong> $${currentCounter}</p>
            <p><strong>Status:</strong> Accepted by customer</p>
        `;
    }

    if (action === "reject") {
        actionText = "❌ Deal Rejected by Customer";
        details = `
            <p><strong>Your Counter Offer:</strong> $${currentCounter}</p>
            <p><strong>Reason:</strong> ${note || "Customer rejected without providing a reason."}</p>
        `;
    }

    if (action === "propose") {
        actionText = "🔄 New Counter Proposal from Customer";
        details = `
            <p><strong>Original Debt:</strong> $${debtAmount}</p>
            <p><strong>Your Previous Counter:</strong> $${currentCounter}</p>
            <p><strong>New Proposed Amount:</strong> $${newAmount}</p>
            <p><strong>Customer Note:</strong> ${note || "No additional note provided."}</p>
        `;
    }

    if (action === "withdraw") {
        actionText = "⚠️ Deal Withdrawn by Customer";
        details = `<p>The customer has withdrawn their deal proposal.</p>`;
    }

    return `
        <div style="font-family: Arial; color:#333">
            <h2>${actionText}</h2>
            <p><strong>Customer:</strong> ${customer.FirstName} ${customer.LastName}</p>
            <p><strong>Deal ID:</strong> ${deal.id}</p>
            ${details}
            <hr/>
            <p><b>TruNorth System Notification</b></p>
        </div>
    `;
};

const dealManager = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Id not provided",
            });
        }

        const { dealId, action, newProposedAmount, note } = req.body;

        if (!dealId || !action) {
            return res.status(400).json({
                success: false,
                message: "Deal ID and action are required",
            });
        }

        // Get the deal with related debt and customer info

        const admin = await models.User.findOne({ where: { role: "admin" } });
        if (!admin) {
            return res.status(404).json({
                success: false,
                message: "Admin not found"
            })
        }
        let deal = await models.Deal.findOne({ where: { id: dealId } })
        let debt = await models.Debt.findOne({ where: { id: deal.debtId } })
        let customer = await models.Customer.findOne({ where: { id: debt.customerId } })
        let user = await models.User.findOne({ where: { id: customer.userId }, attributes: ["id", "email"] })
        deal.Debt = debt
        deal.Debt.Customer = customer
        deal.Debt.Customer.User = user
        if (newProposedAmount && (isNaN(parseFloat(newProposedAmount)))) {
            if (parseFloat(newProposedAmount) <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "New proposed amount must be a positive number",
                });
            }
            if (parseFloat(newProposedAmount) > deal.counterAmount) {
                return res.status(400).json({
                    success: false,
                    message: "New proposed amount must be less than or equals to the counter amount",
                });
            }
            if (parseFloat(newProposedAmount) >= debt.OriginalBalance) {
                return res.status(400).json({
                    success: false,
                    message: "New proposed amount must be less than the original debt balance",
                });
            }
        }

        // Verify deal belongs to this customer
        if (!deal.Debt || !deal.Debt.Customer) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized to access this deal",
            });
        }

        // FIX: Ensure negotiationHistory is always an array
        // Convert to array if it's not already one
        let negotiationHistory = deal.negotiationHistory;
        if (!negotiationHistory) {
            negotiationHistory = [];
        } else if (typeof negotiationHistory === "string") {
            // If it's stored as a string, parse it
            try {
                negotiationHistory = JSON.parse(negotiationHistory);
            } catch (e) {
                negotiationHistory = [];
            }
        } else if (!Array.isArray(negotiationHistory)) {
            // If it's something else, make it an array
            negotiationHistory = [];
        }

        const timestamp = new Date().toISOString();
        const currentProposed = deal.proposedAmount;
        const currentCounter = deal.counterAmount;
        const currentAdminNote = deal.adminNote;

        switch (action.toLowerCase()) {
            case "accept":
                // Customer accepts admin's counter offer
                if (deal.status !== "countered" || !currentCounter) {
                    return res.status(400).json({
                        success: false,
                        message: "No counter offer available to accept",
                    });
                }

                // Add negotiation history BEFORE accepting
                if (currentProposed && currentCounter) {
                    negotiationHistory.push({
                        action: "negotiation_round",
                        clientProposal: currentProposed,
                        adminProposal: currentCounter,
                        clientNote: deal.clientNote,
                        adminNote: currentAdminNote || "",
                        timestamp: timestamp,
                    });
                }

                await deal.update({
                    status: "accepted",
                    finalAmount: currentCounter, // Store counter as final
                    negotiationHistory: negotiationHistory,
                    counterAmount: null,
                    adminNote: null,
                });

                // BUG 1 FIX: Do NOT create PaymentHistory or update debt balance here.
                // Deal acceptance is just an agreement on amount - actual payment happens separately.

                deal = await models.Deal.findOne({
                    where: { id: dealId },
                    include: [
                        {
                            model: models.Debt,
                            include: [
                                {
                                    model: models.Customer,
                                    where: { userId: userId },
                                },
                            ],
                        },
                    ],
                });
                await emailer.sendDealEmail({
                    email: admin.email,
                    body: buildAdminDealEmail({
                        action: action.toLowerCase(),
                        deal,
                        note,
                        newAmount: 0,
                        currentCounter,
                    }),
                });

                return res.status(200).json({
                    success: true,
                    message: "Counter offer accepted successfully",
                    data: deal,
                });

            case "reject":
                // Customer rejects admin's counter offer without new proposal
                if (deal.status !== "countered" || !currentCounter) {
                    return res.status(400).json({
                        success: false,
                        message: "No counter offer available to reject",
                    });
                }

                // Add negotiation history for the rejected round
                if (currentProposed && currentCounter) {
                    negotiationHistory.push({
                        action: "negotiation_round",
                        clientProposal: currentProposed,
                        adminProposal: currentCounter,
                        clientNote: note || "Rejected without counter",
                        adminNote: currentAdminNote || "",
                        timestamp: timestamp,
                    });
                }

                await deal.update({
                    status: "rejected",
                    negotiationHistory: negotiationHistory,
                });
                await emailer.sendDealEmail({
                    email: admin.email,
                    body: buildAdminDealEmail({
                        action: action.toLowerCase(),
                        deal,
                        note,
                        newAmount: 0,
                        currentCounter,
                    }),
                });
                return res.status(200).json({
                    success: true,
                    message: "Counter offer rejected",
                    data: deal,
                });

            case "propose":
                // Customer makes a new proposal (counter to admin's counter)
                if (!newProposedAmount || isNaN(parseFloat(newProposedAmount))) {
                    return res.status(400).json({
                        success: false,
                        message: "Valid new proposed amount is required",
                    });
                }

                const newAmount = parseFloat(newProposedAmount);

                // Store current negotiation round in history
                if (currentProposed && currentCounter) {
                    negotiationHistory.push({
                        action: "negotiation_round",
                        clientProposal: currentProposed,
                        clientNote: deal.clientNote,
                        adminProposal: currentCounter,
                        adminNote: currentAdminNote || "",
                        timestamp: timestamp,
                    });
                }

                await deal.update({
                    status: "pending",
                    proposedAmount: newAmount,
                    clientNote: note || "New proposal made",
                    counterAmount: null, // Clear counter amount
                    adminNote: null, // Clear admin note
                    negotiationHistory: negotiationHistory,
                });
                await emailer.sendDealEmail({
                    email: admin.email,
                    body: buildAdminDealEmail({
                        action: action.toLowerCase(),
                        deal,
                        note,
                        newAmount,
                        currentCounter,
                    }),
                });
                return res.status(200).json({
                    success: true,
                    message: "New proposal sent to admin",
                    data: deal,
                });

            case "withdraw":
                // Customer withdraws their own proposal
                await deal.update({
                    status: "rejected",
                    negotiationHistory: negotiationHistory,
                });
                await emailer.sendDealEmail({
                    email: admin.email,
                    body: buildAdminDealEmail({
                        action: action.toLowerCase(),
                        deal,
                        note,
                        newAmount: 0,
                        currentCounter,
                    }),
                });
                return res.status(200).json({
                    success: true,
                    message: "Deal proposal withdrawn",
                    data: deal,
                });

            default:
                return res.status(400).json({
                    success: false,
                    message: "Invalid action. Use 'accept', 'reject', 'propose', or 'withdraw'",
                });
        }
    } catch (err) {
        console.error("Deal manager error:", err);
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

// Get customer's deals
const getMyDeals = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Id not provided",
            });
        }

        const customer = await models.Customer.findOne({
            where: { userId: userId },
        });

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        const { status, page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;

        const whereClause = {
            debtId: {
                [Op.in]: models.sequelize.literal(`(SELECT id FROM Debts WHERE customerId = ${customer.id})`),
            },
        };

        if (status && ["pending", "accepted", "rejected", "countered"].includes(status)) {
            whereClause.status = status;
        }

        const deals = await models.Deal.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: models.Debt,
                    attributes: ["AccountNumber", "OriginalBalance", "currentBalance", "TypeOfDebt"],
                },
            ],
            order: [["updatedAt", "DESC"]],
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
        console.error("Get my deals error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const fullPayment = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { debtId } = req.body;

        if (!debtId) {
            return res.status(400).json({ success: false, message: "debtId is required" });
        }

        // Verify debt belongs to this customer
        const debt = await models.Debt.findOne({
            where: {
                id: debtId,
                customerId: {
                    [Op.in]: models.sequelize.literal(`(SELECT id FROM Customers WHERE userId = ${userId})`),
                },
            },
        });

        if (!debt) {
            return res.status(404).json({ success: false, message: "Debt not found or unauthorized" });
        }

        if (parseFloat(debt.currentBalance) <= 0) {
            return res.status(400).json({ success: false, message: "Debt already paid" });
        }

        // Use deal amount if an accepted deal exists
        const deal = await models.Deal.findOne({
            where: { debtId: debtId, status: "accepted" }
        });

        let amount;
        if (deal && deal.finalAmount) {
            const agreedAmount = parseFloat(deal.finalAmount);
            const originalDebt = parseFloat(debt.OriginalBalance || agreedAmount);
            const savings = originalDebt - agreedAmount;
            const currentRemaining = parseFloat(debt.currentBalance || 0);

            let remainingDeal = currentRemaining - savings;
            amount = remainingDeal < 0 ? 0 : parseFloat(remainingDeal.toFixed(2));
        } else {
            amount = parseFloat(debt.currentBalance);
        }

        if (amount <= 0) {
            return res.status(400).json({ success: false, message: "Debt already paid or balance is zero" });
        }

        const invoiceNumber = `FP-${debtId}-${Date.now().toString().slice(-6)}`;

        // Create pending PaymentHistory
        const paymentHistory = await models.PaymentHistory.create({
            debtId,
            userId,
            amount,
            paymentType: "full",
            status: "pending",
            invoiceNumber,
            gateway: "authorize_net",
        });

        // Get Accept Hosted token
        const returnUrl = (process.env.PAYMENT_RETURN_URL || "http://localhost:5173/client/payment-return").trim();
        const token = await authorizeNet.getHostedPaymentPageToken({
            amount,
            invoiceNumber,
            description: `Full payment for Account #${debt.AccountNumber}`,
            customerId: userId.toString(),
            returnUrl,
        });

        return res.status(200).json({
            success: true,
            message: "Payment initiated",
            data: {
                token,
                paymentHistoryId: paymentHistory.id,
            },
        });
    } catch (err) {
        console.error("Full payment error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const initiateInstallmentPlan = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { debtId, numberOfInstallments } = req.body;

        if (!debtId || !numberOfInstallments) {
            return res.status(400).json({ success: false, message: "debtId and numberOfInstallments are required" });
        }

        const validPlans = [3, 6, 9, 12];
        if (!validPlans.includes(numberOfInstallments)) {
            return res.status(400).json({
                success: false,
                message: `numberOfInstallments must be one of: ${validPlans.join(", ")}`,
            });
        }

        // Verify debt belongs to customer
        const debt = await models.Debt.findOne({
            where: {
                id: debtId,
                customerId: {
                    [Op.in]: models.sequelize.literal(`(SELECT id FROM Customers WHERE userId = ${userId})`),
                },
            },
        });

        if (!debt) {
            return res.status(404).json({ success: false, message: "Debt not found or unauthorized" });
        }

        if (parseFloat(debt.currentBalance) <= 0) {
            return res.status(400).json({ success: false, message: "Debt already paid" });
        }

        // Check for existing installments
        const existingInstallments = await models.Installment.count({ where: { debtId } });
        if (existingInstallments > 0) {
            return res.status(400).json({ success: false, message: "Installments already exist for this debt" });
        }

        // Check for active deals
        const activeDeal = await models.Deal.findOne({
            where: { debtId, status: { [Op.in]: ["pending", "countered", "accepted"] } },
        });
        if (activeDeal) {
            return res.status(400).json({
                success: false,
                message: `Deal is in ${activeDeal.status} state for this debt`,
            });
        }

        const totalAmount = parseFloat(debt.currentBalance);
        const installmentAmount = parseFloat((totalAmount / numberOfInstallments).toFixed(2));
        const invoicePrefix = `INST-${debtId}`;

        const transaction = await models.sequelize.transaction();
        try {
            // Create N installment records
            const installments = [];
            const today = new Date();
            for (let i = 0; i < numberOfInstallments; i++) {
                const dueDate = new Date(today.getFullYear(), today.getMonth() + i + 1, 5);
                installments.push({
                    debtId,
                    userId,
                    installmentNo: i + 1,
                    amount: installmentAmount,
                    dueDate,
                    status: "pending",
                    installmentType: "monthly",
                });
            }

            const createdInstallments = await models.Installment.bulkCreate(installments, { transaction });

            // Create PaymentHistory for first installment
            const invoiceNumber = `${invoicePrefix}-1-${Date.now().toString().slice(-6)}`;
            const paymentHistory = await models.PaymentHistory.create(
                {
                    debtId,
                    userId,
                    installmentId: createdInstallments[0].id,
                    amount: installmentAmount,
                    paymentType: "installment",
                    status: "pending",
                    invoiceNumber,
                    gateway: "authorize_net",
                },
                { transaction }
            );

            // Update debt status
            await models.Debt.update({ status: "active" }, { where: { id: debtId }, transaction });

            // Get Accept Hosted token for first installment
            const returnUrl = (process.env.PAYMENT_RETURN_URL || "http://localhost:5173/client/payment-return").trim();
            const token = await authorizeNet.getHostedPaymentPageToken({
                amount: installmentAmount,
                invoiceNumber,
                description: `Installment 1/${numberOfInstallments} for Account #${debt.AccountNumber}`,
                customerId: userId.toString(),
                returnUrl,
            });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Installment plan created, pay first installment",
                data: {
                    token,
                    paymentHistoryId: paymentHistory.id,
                    installments: createdInstallments,
                },
            });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error("Initiate installment plan error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const paymentReturn = async (req, res) => {
    try {
        const { phId } = req.query;

        if (!phId) {
            return res.status(400).json({ success: false, message: "Payment history ID is required" });
        }

        const payment = await models.PaymentHistory.findOne({
            where: { id: phId, userId: req.user.userId },
            include: [{ model: models.Debt, attributes: ["AccountNumber", "currentBalance"] }],
        });

        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found" });
        }

        return res.status(200).json({
            success: true,
            data: {
                id: payment.id,
                amount: payment.amount,
                status: payment.status,
                paymentType: payment.paymentType,
                invoiceNumber: payment.invoiceNumber,
                authorizeTransactionId: payment.authorizeTransactionId,
                debt: payment.Debt,
                createdAt: payment.createdAt,
            },
        });
    } catch (err) {
        console.error("Payment return error:", err);
        return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
    }
};

const getPaymentStatus = async (req, res) => {
    try {
        const { paymentHistoryId } = req.params;

        const payment = await models.PaymentHistory.findOne({
            where: { id: paymentHistoryId, userId: req.user.userId },
            attributes: ["id", "status", "authorizeTransactionId", "amount", "paymentType", "updatedAt"],
        });

        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found" });
        }

        return res.status(200).json({
            success: true,
            data: payment,
        });
    } catch (err) {
        console.error("Get payment status error:", err);
        return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
    }
};

const createInstallments = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Id not provided",
            });
        }

        const { debtId, numberOfInstallments } = req.body;
        const deal = await models.Deal.findOne({
            where: { debtId: debtId },
        });
        if (deal) {
            if (deal.status === "pending" || deal.status === "countered") {
                return res.status(400).json({
                    success: false,
                    message: `Deal is in ${deal.status} state for this debt, cannot create installments`,
                });
            }
        }
        if (!debtId || !numberOfInstallments) {
            return res.status(400).json({
                success: false,
                message: "All fields are required",
            });
        }

        // FIX 1: Check if customer owns this debt
        const debt = await models.Debt.findOne({
            where: {
                id: debtId,
                customerId: {
                    [Op.in]: models.sequelize.literal(`(SELECT id FROM Customers WHERE userId = ${userId})`),
                },
            },
        });

        if (!debt) {
            return res.status(404).json({
                success: false,
                message: "Debt not found or unauthorized",
            });
        }

        // FIX 2: Check if debt already has installments
        const existingInstallments = await models.Installment.count({
            where: { DebtId: debtId },
        });

        if (existingInstallments > 0) {
            return res.status(400).json({
                success: false,
                message: "Installments already exist for this debt",
            });
        }

        // FIX 3: Check if numberOfInstallments is valid
        if (numberOfInstallments <= 0 || !Number.isInteger(numberOfInstallments)) {
            return res.status(400).json({
                success: false,
                message: "Number of installments must be a positive integer",
            });
        }

        // FIX 4: Calculate installment amount based on accepted deal or current balance
        let targetBalance = debt.currentBalance;
        if (deal && deal.status === "accepted" && deal.finalAmount) {
            targetBalance = deal.finalAmount;
        }

        const installmentAmount = parseFloat((targetBalance / numberOfInstallments).toFixed(2));

        // FIX 5: Verify installment amount is valid
        if (installmentAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Cannot create installments for zero balance",
            });
        }

        // FIX 6: Create due dates based on installment type
        const dueDates = [];
        const today = new Date();

        for (let i = 1; i <= numberOfInstallments; i++) {
            const dueDate = new Date(today.getFullYear(), today.getMonth() + i, 5);
            dueDates.push(dueDate);
        }

        // FIX 7: Create installments array
        const installments = [];
        for (let i = 0; i < numberOfInstallments; i++) {
            installments.push({
                installmentType: "monthly",
                debtId: debtId, // FIX: lowercase 'd' as per your model
                installmentNo: i + 1, // FIX: 'installmentNo' as per your model
                amount: installmentAmount,
                dueDate: dueDates[i],
                status: "pending",
                userId: userId,
            });
        }

        // FIX 8: Use transaction for data integrity
        const transaction = await models.sequelize.transaction();

        try {
            // Create installments
            const result = await models.Installment.bulkCreate(installments, { transaction });

            // Update debt status to active
            await models.Debt.update({ status: "active" }, { where: { id: debtId }, transaction });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Installments created successfully",
                data: result,
            });
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (err) {
        console.error("Create installments error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const payInstallment = async (req, res) => {
    try {
        if (req.user.role !== "customer") {
            return res.status(403).json({
                success: false,
                message: "Unauthorized",
            });
        }

        const userId = req.user.userId;
        const installmentId = req.params.installmentId;
        // const { amount } = req.body;

        const installment = await models.Installment.findOne({
            where: { id: installmentId, userId: userId },
            include: [{ model: models.Debt }] // Need to include Debt for updates
        });

        if (!installment) {
            return res.status(404).json({
                success: false,
                message: "Installment not found",
            });
        }

        if (installment.status !== "pending") {
            return res.status(400).json({
                success: false,
                message: "Installment is not pending",
            });
        }

        // if (amount <= 0) {
        //     return res.status(400).json({
        //         success: false,
        //         message: "Amount must be greater than 0",
        //     });
        // }

        // if (amount > installment.amount) {
        //     return res.status(400).json({
        //         success: false,
        //         message: "Amount exceeds installment amount",
        //     });
        // }

        const transaction = await models.sequelize.transaction();

        try {
            installment.status = "paid";
            installment.paidAt = new Date();
            await installment.save({ transaction });

            // Deduct the installment amount from the Debt's currentBalance
            const debt = installment.Debt;
            if (debt) {
                const deductionAmount = parseFloat(installment.amount);
                let newBalance = parseFloat(debt.currentBalance) - deductionAmount;
                if (newBalance <= 0) {
                    newBalance = 0;
                    debt.status = "paid";
                }
                debt.currentBalance = parseFloat(newBalance.toFixed(2));
                debt.PaidToDate = parseFloat((parseFloat(debt.PaidToDate || 0) + deductionAmount).toFixed(2));
                await debt.save({ transaction });
            }

            await models.PaymentHistory.create({
                debtId: installment.debtId,
                amount: installment.amount,
                installmentId: installment.id,
                userId: userId,
                paymentType: "installment",
                status: "completed",
                sessionId: null,
                sessionUrl: null,
            }, { transaction });

            await transaction.commit();

            return res.status(200).json({
                success: true,
                message: "Installment paid successfully",
            });
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (err) {
        console.error("Pay installment error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const getLatestInstallment = async (req, res) => {
    try {
        if (req.user.role !== "customer") {
            return res.status(403).json({
                success: false,
                message: "Unauthorized",
            });
        }

        const userId = req.user.userId;

        // Fetch the customer using userId
        const customer = await models.Customer.findOne({
            where: { userId: userId },
        });

        if (!customer) {
            return res.status(200).json({
                success: true,
                message: "No customer record found",
                data: null,
            });
        }

        // Get all debts of this customer
        const customerDebts = await models.Debt.findAll({
            where: { customerId: customer.id },
            attributes: ["id"],
        });

        if (customerDebts.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No debts found for this customer",
                data: null,
            });
        }

        const debtIds = customerDebts.map((debt) => debt.id);

        // Fetch the earliest pending installment
        const latestInstallment = await models.Installment.findOne({
            where: {
                debtId: { [Op.in]: debtIds },
                status: { [Op.in]: ["pending", "processing"] },
            },
            include: [
                {
                    model: models.Debt,
                    attributes: ["AccountNumber", "OriginalBalance", "currentBalance"],
                },
            ],
            order: [["dueDate", "ASC"]], // ASC to get the earliest (closest) due date
        });

        if (!latestInstallment) {
            return res.status(200).json({
                success: true,
                message: "No pending installments found",
                data: null,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Next installment retrieved successfully",
            data: latestInstallment,
        });
    } catch (err) {
        console.error("Get latest installment error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
            data: null,
        });
    }
};

const getPaymentHistory = async (req, res) => {
    try {
        const userId = req.user.userId;
        const userRole = req.user.role;

        if (userRole !== "customer") {
            return res.status(403).json({
                success: false,
                message: "Unauthorized. Customers only.",
            });
        }

        // Get query parameters for pagination
        const { page = 1, limit = 20, paymentType } = req.query;
        const offset = (page - 1) * limit;

        // Build where clause
        const whereClause = { userId: userId };

        if (paymentType && ["full", "installment", "deal_settlement"].includes(paymentType)) {
            whereClause.paymentType = paymentType;
        }

        // Get customer to verify
        const customer = await models.Customer.findOne({
            where: { userId: userId },
        });

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        // Fetch payment history with pagination
        const payments = await models.PaymentHistory.findAndCountAll({
            where: whereClause,
            include: [
                {
                    model: models.Debt,
                    attributes: ["id", "AccountNumber", "OriginalBalance", "currentBalance", "OriginalCreditor"],
                    where: { customerId: customer.id },
                    required: true,
                },
                {
                    model: models.Installment,
                    attributes: ["id", "installmentNo", "amount", "dueDate", "status"],
                    required: false, // LEFT JOIN for installment payments only
                },
            ],
            order: [["createdAt", "DESC"]],
            limit: parseInt(limit),
            offset: parseInt(offset),
        });

        // Format response based on payment type
        const formattedPayments = payments.rows.map((payment) => {
            const paymentData = payment.toJSON();

            // Base payment info
            const response = {
                id: paymentData.id,
                amount: paymentData.amount,
                status: paymentData.status,
                paymentType: paymentData.paymentType,
                sessionId: paymentData.sessionId,
                createdAt: paymentData.createdAt,
                debt: {
                    accountNumber: paymentData.Debt?.AccountNumber,
                    originalCreditor: paymentData.Debt?.OriginalCreditor,
                    originalBalance: paymentData.Debt?.OriginalBalance,
                    currentBalance: paymentData.Debt?.currentBalance,
                },
            };

            // Add installment info only for installment payments
            if (paymentData.paymentType === "installment" && paymentData.Installment) {
                response.installment = {
                    id: paymentData.Installment.id,
                    installmentNo: paymentData.Installment.installmentNo,
                    dueDate: paymentData.Installment.dueDate,
                    status: paymentData.Installment.status,
                };
            }
            // For full and deal_settlement payments, don't include installment info

            return response;
        });

        return res.status(200).json({
            success: true,
            message: "Payment history retrieved successfully",
            data: {
                payments: formattedPayments,
                pagination: {
                    total: payments.count,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(payments.count / limit),
                },
            },
        });
    } catch (err) {
        console.error("Get payment history error:", err);
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const getMyDebts = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized, due to missing id",
            });
        }
        const customer = await models.Customer.findOne({
            where: { userId: userId },
        });
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }
        const customerDebts = await models.Debt.findAll({
            where: { customerId: customer.id },
        });
        return res.status(200).json({
            success: true,
            message: "Debts retrieved successfully",
            data: customerDebts,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const getProfile = async (req, res) => {
    try {
        const userId = req.user.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized, due to missing id",
            });
        }
        const customer = await models.Customer.findOne({
            where: { userId: userId },
            include: [
                {
                    model: models.User,
                    attributes: ["email"],
                    required: true,
                },
            ],
        });
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }
        return res.status(200).json({
            success: true,
            message: "Profile retrieved successfully",
            data: customer,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

const updateProfile = async (req, res) => {
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
            password,
            confirmPassword,
        } = req.body;

        // Find the customer
        const customer = await models.Customer.findOne({
            where: { userId: userId },
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

        let userUpdates = {};

        // Password update (for User model)
        if (password !== undefined && password !== null && password !== "") {
            if (!confirmPassword) {
                validationErrors.push("Confirm password is required when changing password");
            } else if (password !== confirmPassword) {
                validationErrors.push("Password and confirm password do not match");
            } else if (password.length < 8) {
                validationErrors.push("Password must be at least 8 characters long");
            } else {
                // Check password strength
                const hasUpperCase = /[A-Z]/.test(password);
                const hasLowerCase = /[a-z]/.test(password);
                const hasNumbers = /\d/.test(password);
                const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

                if (!hasUpperCase || !hasLowerCase || !hasNumbers || !hasSpecialChar) {
                    validationErrors.push(
                        "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
                    );
                } else {
                    const hashedPassword = await bcrypt.hash(password, 10);
                    userUpdates.password = hashedPassword;
                }
            }
        }

        // Check if there are any validation errors
        if (validationErrors.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Validation errors",
                errors: validationErrors,
            });
        }

        // Check if there are any updates to make
        if (Object.keys(updates).length === 0 && Object.keys(userUpdates).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No updates provided to change",
            });
        }

        // Perform updates
        if (Object.keys(updates).length > 0) {
            await customer.update(updates);
        }

        if (Object.keys(userUpdates).length > 0) {
            const user = await models.User.findOne({ where: { id: userId } });
            if (user) {
                await user.update(userUpdates);
            }
        }

        // Get updated customer data
        const updatedCustomer = await models.Customer.findOne({
            where: { userId: userId },
            include: [
                {
                    model: models.User,
                    attributes: ["id", "email"],
                },
            ],
        });

        return res.status(200).json({
            success: true,
            message: "Profile updated successfully",
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

const getInstallmentHistory = async (req, res) => {
    try {
        const { userId } = req.user;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized, due to missing id",
            });
        }

        // Use query parameter instead of route parameter
        const debtId = req.query.debtId || req.params.debtId;

        const customer = await models.Customer.findOne({
            where: { userId: userId },
        });
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        let customerDebts;
        if (!debtId) {
            customerDebts = await models.Debt.findAll({
                where: { customerId: customer.id },
                include: [
                    {
                        model: models.Installment,
                        where: { status: "paid" },
                        required: false,
                    },
                ],
            });
        } else {
            customerDebts = await models.Debt.findOne({
                where: { id: debtId, customerId: customer.id },
                include: [
                    {
                        model: models.Installment,
                        where: { status: "paid" },
                        required: false,
                    },
                ],
            });
        }

        return res.status(200).json({
            success: true,
            message: "Installment history retrieved successfully",
            data: customerDebts,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

// Add this after the getInstallmentHistory function but before module.exports
const getInstallmentHistoryAll = async (req, res) => {
    try {
        const { userId } = req.user;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized, due to missing id",
            });
        }

        const customer = await models.Customer.findOne({
            where: { userId: userId },
        });
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        const customerDebts = await models.Debt.findAll({
            where: { customerId: customer.id },
            include: [
                {
                    model: models.Installment,
                    where: { status: "paid" },
                    required: false,
                },
            ],
        });

        return res.status(200).json({
            success: true,
            message: "Installment history retrieved successfully",
            data: customerDebts,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

module.exports = {
    dashboard,
    createDeal,
    dealManager,
    getMyDeals,
    createInstallments,
    fullPayment,
    initiateInstallmentPlan,
    paymentReturn,
    getPaymentStatus,
    getLatestInstallment,
    getDealHistory,
    getPaymentHistory,
    payInstallment,
    getMyDebts,
    getProfile,
    updateProfile,
    getInstallmentHistory,
    getInstallmentHistoryAll,
};
