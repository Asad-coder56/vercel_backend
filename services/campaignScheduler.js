const models = require('../models/index');
const emailer = require('./emailService');
const { Op } = require('sequelize');

const processScheduledCampaigns = async () => {
    try {
        const now = new Date();
        console.log(`🕒 [Scheduler] Checking at: ${now.toLocaleString()}`);

        const scheduledCampaigns = await models.Campaign.findAll({
            where: {
                deliveryMode: 'schedule',
                status: 'Scheduled',
                scheduledDate: {
                    [Op.lte]: now,
                },
            },
            include: [{ model: models.EmailTemplate }],
        });

        if (scheduledCampaigns.length === 0) {
            return; // Nothing due yet, silent exit
        }

        console.log(`📅 Found ${scheduledCampaigns.length} scheduled campaign(s) ready to send.`);

        for (const campaign of scheduledCampaigns) {
            try {
                console.log(`🚀 Processing campaign: "${campaign.name}" (ID: ${campaign.id}), scheduled for: ${new Date(campaign.scheduledDate).toLocaleString()}`);
                await sendScheduledCampaign(campaign);
            } catch (err) {
                console.error(`❌ Failed to send scheduled campaign ${campaign.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('❌ Error while processing scheduled campaigns:', err.message);
    }
};

const sendScheduledCampaign = async (campaign) => {
    if (!campaign) return;

    const template = campaign.EmailTemplate || await models.EmailTemplate.findByPk(campaign.templateId);
    if (!template) {
        console.error(`❌ EmailTemplate not found for campaign ${campaign.id}`);
        await campaign.update({ status: 'Failed' });
        return;
    }

    const pendingEmails = await models.SystemEmail.findAll({
        where: {
            campaignId: campaign.id,
            status: 'pending',
        },
    });

    if (pendingEmails.length === 0) {
        console.warn(`⚠️  No pending emails found for scheduled campaign ${campaign.id} — marking as Failed.`);
        await campaign.update({ status: 'Failed' });
        return;
    }

    console.log(`📬 Campaign ${campaign.id}: found ${pendingEmails.length} pending email(s) to dispatch.`);

    const userIds = pendingEmails.map((email) => email.userId).filter(Boolean);
    const users = await models.User.findAll({
        where: {
            id: {
                [Op.in]: userIds,
            },
        },
        include: [{ model: models.Customer, required: false }],
    });

    const usersById = users.reduce((map, user) => {
        map[user.id] = user;
        return map;
    }, {});

    let successCount = 0;
    let failedCount = 0;

    for (const emailRow of pendingEmails) {
        const user = usersById[emailRow.userId];
        if (!user || !emailRow.receiverEmail) {
            failedCount += 1;
            console.warn(`⚠️  Skipping email row ${emailRow.id}: user or email missing.`);
            await emailRow.update({ status: 'failed' });
            continue;
        }

        try {
            const info = await emailer.sendIndividualEmail({
                user,
                subject: template.subject,
                body: template.body,
                templateId: template.id,
            });

            successCount += 1;
            await emailRow.update({
                status: 'sent',
                sentAt: new Date(),
                messageId: info?.messageId || null,
            });
            console.log(`✅ Email sent to ${emailRow.receiverEmail} (messageId=${info?.messageId || 'none'})`);
        } catch (sendErr) {
            failedCount += 1;
            console.error(`❌ Failed sending to ${emailRow.receiverEmail}:`, sendErr.message);
            await emailRow.update({
                status: 'failed',
            });
        }
    }

    const campaignStatus = successCount > 0 ? 'Sent' : 'Failed';
    await campaign.update({ status: campaignStatus });

    console.log(`📬 Scheduled campaign "${campaign.name}" (ID: ${campaign.id}) done: ${successCount} sent, ${failedCount} failed.`);
};

const startCampaignScheduler = (intervalMs = 60 * 1000) => {
    console.log(`🔄 Campaign scheduler started — checking every ${intervalMs / 1000}s`);
    processScheduledCampaigns();
    setInterval(processScheduledCampaigns, intervalMs);
};

module.exports = {
    startCampaignScheduler,
};
