const ApiContracts = require("authorizenet").APIContracts;
const ApiControllers = require("authorizenet").APIControllers;
const SDKConstants = require("authorizenet").Constants;
require("dotenv").config();

const getEnvironment = () => {
    return process.env.AUTHORIZE_ENVIRONMENT === "production"
        ? SDKConstants.endpoint.production
        : SDKConstants.endpoint.sandbox;
};

const getMerchantAuth = () => {
    const merchantAuth = new ApiContracts.MerchantAuthenticationType();
    merchantAuth.setName(process.env.AUTHORIZE_API_LOGIN_ID);
    merchantAuth.setTransactionKey(process.env.AUTHORIZE_TRANSACTION_KEY);
    return merchantAuth;
};

/**
 * Get Accept Hosted payment page token
 * @param {Object} options
 * @param {number} options.amount - Payment amount
 * @param {string} options.invoiceNumber - Unique invoice number (e.g., FP-123 or INST-123-1)
 * @param {string} options.description - Payment description
 * @param {string} options.customerId - Customer identifier
 * @param {string} options.returnUrl - URL to redirect after payment
 * @returns {Promise<string>} The hosted payment page token
 */
const getHostedPaymentPageToken = async ({ amount, invoiceNumber, description, customerId, returnUrl }) => {
    return new Promise((resolve, reject) => {
        // Validate and get the return URL
        // Note: Use base URL without query params - Authorize.net has issues with query params in some cases
        const baseReturnUrl = process.env.PAYMENT_RETURN_URL || "http://localhost:5173/client/payment-return";

        // For the callback, we'll use the base URL and pass data via the response
        const finalReturnUrl = baseReturnUrl;

        // Ensure URL starts with http:// or https://
        if (!finalReturnUrl.startsWith("http://") && !finalReturnUrl.startsWith("https://")) {
            reject(new Error(`Invalid return URL: ${finalReturnUrl}. Must start with http:// or https://`));
            return;
        }

        console.log("📍 Authorize.Net Return URL:", finalReturnUrl);
        console.log("📍 Original returnUrl param:", returnUrl);

        const merchantAuth = getMerchantAuth();

        const transactionRequestType = new ApiContracts.TransactionRequestType();
        transactionRequestType.setTransactionType(ApiContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION);
        transactionRequestType.setAmount(amount);

        const order = new ApiContracts.OrderType();
        order.setInvoiceNumber(invoiceNumber);
        order.setDescription(description || "TruNorth Debt Payment");
        transactionRequestType.setOrder(order);

        if (customerId) {
            const customer = new ApiContracts.CustomerDataType();
            customer.setId(customerId);
            transactionRequestType.setCustomer(customer);
        }

        // Hosted payment page settings
        console.log("📋 Building Authorize.net settings with URL:", finalReturnUrl);

        // Create settings - testing different JSON encoding approaches
        const settings = [];

        // IMPORTANT: Authorize.net rejects localhost URLs
        // For development, use ngrok or deploy to a public URL
        // For production, use your actual domain
        const baseUrl = finalReturnUrl.endsWith('/') ? finalReturnUrl.slice(0, -1) : finalReturnUrl;
        const returnOpts = {
            showReceipt: true,
            url: `${baseUrl}/success`,
            urlText: "Continue to Dashboard",
            cancelUrl: `${baseUrl}/cancel`,
            cancelUrlText: "Cancel Payment"
        };
        console.log("📋 Return URL:", baseUrl);
        console.log("📋 Return options JSON:", JSON.stringify(returnOpts));

        // Warning if using localhost
        if (finalReturnUrl.includes("localhost")) {
            console.warn("⚠️ WARNING: localhost URLs are rejected by Authorize.net. Use ngrok or a public URL.")
        }

        const settingReturn = new ApiContracts.SettingType();
        settingReturn.setSettingName("hostedPaymentReturnOptions");
        settingReturn.setSettingValue(JSON.stringify(returnOpts));
        settings.push(settingReturn);

        // Button text
        const settingButton = new ApiContracts.SettingType();
        settingButton.setSettingName("hostedPaymentButtonOptions");
        settingButton.setSettingValue(JSON.stringify({ text: "Pay Now" }));
        settings.push(settingButton);

        // Payment options
        const settingPayment = new ApiContracts.SettingType();
        settingPayment.setSettingName("hostedPaymentPaymentOptions");
        settingPayment.setSettingValue(JSON.stringify({ cardCodeRequired: true, showCreditCard: true, showBankAccount: false }));
        settings.push(settingPayment);

        const settingList = new ApiContracts.ArrayOfSetting();
        settingList.setSetting(settings);

        // Log the full request for debugging
        const request = new ApiContracts.GetHostedPaymentPageRequest();
        request.setMerchantAuthentication(merchantAuth);
        request.setTransactionRequest(transactionRequestType);
        request.setHostedPaymentSettings(settingList);

        console.log("📋 Full request JSON:", JSON.stringify(request.getJSON(), null, 2));

        const controller = new ApiControllers.GetHostedPaymentPageController(request.getJSON());
        controller.setEnvironment(getEnvironment());

        controller.execute(() => {
            const response = controller.getResponse();
            const result = new ApiContracts.GetHostedPaymentPageResponse(response);

            if (
                result.getMessages().getResultCode() ===
                ApiContracts.MessageTypeEnum.OK
            ) {
                resolve(result.getToken());
            } else {
                const errorMsg =
                    result.getMessages().getMessage()[0].getText();
                reject(new Error(`Authorize.Net error: ${errorMsg}`));
            }
        });
    });
};

/**
 * Create customer profile from a completed transaction
 * This tokenizes the card used in the Accept Hosted payment for future ARB charges
 * @param {string} transactionId - The completed transaction ID
 * @returns {Promise<{customerProfileId: string, paymentProfileId: string}>}
 */
const createCustomerProfileFromTransaction = async (transactionId) => {
    return new Promise((resolve, reject) => {
        const merchantAuth = getMerchantAuth();

        const request = new ApiContracts.CreateCustomerProfileFromTransactionRequest();
        request.setMerchantAuthentication(merchantAuth);
        request.setTransId(transactionId);

        const controller = new ApiControllers.CreateCustomerProfileFromTransactionController(request.getJSON());
        controller.setEnvironment(getEnvironment());

        controller.execute(() => {
            const response = controller.getResponse();
            const result = new ApiContracts.CreateCustomerProfileResponse(response);

            if (
                result.getMessages().getResultCode() ===
                ApiContracts.MessageTypeEnum.OK
            ) {
                const customerProfileId = result.getCustomerProfileId();
                const paymentProfileIds = result.getCustomerPaymentProfileIdList()?.getNumericString();
                const paymentProfileId = paymentProfileIds ? paymentProfileIds[0] : null;

                resolve({ customerProfileId, paymentProfileId });
            } else {
                const messages = result.getMessages().getMessage();
                const errorCode = messages[0].getCode();
                const errorMsg = messages[0].getText();

                // E00039 = duplicate profile — extract existing IDs from message
                if (errorCode === "E00039") {
                    const profileIdMatch = errorMsg.match(/(\d+)/);
                    if (profileIdMatch) {
                        resolve({
                            customerProfileId: profileIdMatch[0],
                            paymentProfileId: null,
                            isDuplicate: true,
                        });
                        return;
                    }
                }
                reject(new Error(`Authorize.Net error: ${errorMsg}`));
            }
        });
    });
};

/**
 * Create ARB (Automated Recurring Billing) subscription
 * @param {Object} options
 * @param {string} options.customerProfileId - Authorize.Net customer profile ID
 * @param {string} options.paymentProfileId - Authorize.Net payment profile ID
 * @param {number} options.amount - Monthly charge amount
 * @param {number} options.totalOccurrences - Total number of charges
 * @param {Date} options.startDate - When to start charging (YYYY-MM-DD)
 * @param {string} options.invoicePrefix - Prefix for invoices (e.g., "INST-123")
 * @param {string} options.description - Subscription description
 * @returns {Promise<string>} The subscription ID
 */
const createARBSubscription = async ({
    customerProfileId,
    paymentProfileId,
    amount,
    totalOccurrences,
    startDate,
    invoicePrefix,
    description,
}) => {
    return new Promise((resolve, reject) => {
        const merchantAuth = getMerchantAuth();

        const interval = new ApiContracts.PaymentScheduleType.Interval();
        interval.setLength(1);
        interval.setUnit(ApiContracts.ARBSubscriptionUnitEnum.MONTHS);

        const paymentSchedule = new ApiContracts.PaymentScheduleType();
        paymentSchedule.setInterval(interval);
        paymentSchedule.setStartDate(startDate);
        paymentSchedule.setTotalOccurrences(totalOccurrences);
        paymentSchedule.setTrialOccurrences(0);

        const profile = new ApiContracts.CustomerProfileIdType();
        profile.setCustomerProfileId(customerProfileId);
        profile.setCustomerPaymentProfileId(paymentProfileId);

        const order = new ApiContracts.OrderType();
        order.setInvoiceNumber(`${invoicePrefix}-ARB`);
        order.setDescription(description || "TruNorth Installment Payment");

        const subscription = new ApiContracts.ARBSubscriptionType();
        subscription.setName(`TruNorth-${invoicePrefix}`);
        subscription.setPaymentSchedule(paymentSchedule);
        subscription.setAmount(amount);
        subscription.setTrialAmount(0);
        subscription.setProfile(profile);
        subscription.setOrder(order);

        const request = new ApiContracts.ARBCreateSubscriptionRequest();
        request.setMerchantAuthentication(merchantAuth);
        request.setSubscription(subscription);

        const controller = new ApiControllers.ARBCreateSubscriptionController(request.getJSON());
        controller.setEnvironment(getEnvironment());

        controller.execute(() => {
            const response = controller.getResponse();
            const result = new ApiContracts.ARBCreateSubscriptionResponse(response);

            if (
                result.getMessages().getResultCode() ===
                ApiContracts.MessageTypeEnum.OK
            ) {
                resolve(result.getSubscriptionId());
            } else {
                const errorMsg =
                    result.getMessages().getMessage()[0].getText();
                reject(new Error(`Authorize.Net ARB error: ${errorMsg}`));
            }
        });
    });
};

/**
 * Cancel an ARB subscription
 * @param {string} subscriptionId - The ARB subscription ID to cancel
 * @returns {Promise<boolean>}
 */
const cancelARBSubscription = async (subscriptionId) => {
    return new Promise((resolve, reject) => {
        const merchantAuth = getMerchantAuth();

        const request = new ApiContracts.ARBCancelSubscriptionRequest();
        request.setMerchantAuthentication(merchantAuth);
        request.setSubscriptionId(subscriptionId);

        const controller = new ApiControllers.ARBCancelSubscriptionController(request.getJSON());
        controller.setEnvironment(getEnvironment());

        controller.execute(() => {
            const response = controller.getResponse();
            const result = new ApiContracts.ARBCancelSubscriptionResponse(response);

            if (
                result.getMessages().getResultCode() ===
                ApiContracts.MessageTypeEnum.OK
            ) {
                resolve(true);
            } else {
                const errorMsg =
                    result.getMessages().getMessage()[0].getText();
                reject(new Error(`Authorize.Net cancel error: ${errorMsg}`));
            }
        });
    });
};

/**
 * Generates an Authorize.net Accept Hosted payment session.
 * 
 * @param {number} amount - The transaction amount
 * @param {string} invoiceNumber - The invoice number
 * @param {string} customerEmail - Customer email address
 * @returns {Promise<Object>} Object containing the token and hosted payment URL
 */
// const getHostedPaymentPage = (amount, invoiceNumber, customerEmail) => {
//     return new Promise((resolve, reject) => {
//         try {
//             // 1. Authenticate using API Login ID and Transaction Key
//             const merchantAuth = getMerchantAuth();

//             // 2 & 3. Create an authCaptureTransaction transaction
//             const transactionRequestType = new ApiContracts.TransactionRequestType();
//             transactionRequestType.setTransactionType(ApiContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION);

//             // 4. Set the amount from the request body
//             transactionRequestType.setAmount(amount.toString());

//             // 5. Set the invoice number from the request body
//             const orderType = new ApiContracts.OrderType();
//             orderType.setInvoiceNumber(invoiceNumber);
//             orderType.setDescription('Payment for Invoice ' + invoiceNumber);
//             transactionRequestType.setOrder(orderType);

//             // Set customer
//             if (customerEmail) {
//                 const customerType = new ApiContracts.CustomerDataType();
//                 customerType.setEmail(customerEmail);
//                 transactionRequestType.setCustomer(customerType);
//             }

//             // 6. Configure hosted payment settings
//             const setting1 = new ApiContracts.SettingType();
//             setting1.setSettingName('hostedPaymentButtonOptions');
//             setting1.setSettingValue('{"text": "Pay"}');

//             const setting2 = new ApiContracts.SettingType();
//             setting2.setSettingName('hostedPaymentOrderOptions');
//             setting2.setSettingValue('{"show": true}');

//             const settingListArray = [];
//             settingListArray.push(setting1);
//             settingListArray.push(setting2);

//             // Add the Return URL from .env (to redirect back to React App)
//             let returnUrl = process.env.PAYMENT_RETURN_URL || "http://localhost:5173/client/payment-return";
//             returnUrl = returnUrl.trim();
//             // Ensure HTTPS and remove double slashes
//             returnUrl = returnUrl.replace(/([^:]\/)\/+/g, "$1").replace("http://api.test", "https://api.test");

//             if (returnUrl) {
//                 const settingReturn = new ApiContracts.SettingType();
//                 settingReturn.setSettingName('hostedPaymentReturnOptions');
//                 settingReturn.setSettingValue(JSON.stringify({
//                     showReceipt: true,
//                     url: returnUrl,
//                     urlText: 'Continue',
//                     cancelUrl: returnUrl,
//                     cancelUrlText: 'Cancel'
//                 }));
//                 settingListArray.push(settingReturn);
//             }

//             const settingList = new ApiContracts.ArrayOfSetting();
//             settingList.setSetting(settingListArray);

//             // Create the request
//             const getRequest = new ApiContracts.GetHostedPaymentPageRequest();
//             getRequest.setMerchantAuthentication(merchantAuth);
//             getRequest.setTransactionRequest(transactionRequestType);
//             getRequest.setHostedPaymentSettings(settingList);

//             // Execute the request via the controller
//             const ctrl = new ApiControllers.GetHostedPaymentPageController(getRequest.getJSON());

//             // Check Sandbox vs Production Environment
//             const isSandbox = process.env.AUTHORIZE_ENVIRONMENT === 'sandbox';
//             if (isSandbox) {
//                 ctrl.setEnvironment(SDKConstants.endpoint.sandbox);
//             } else {
//                 ctrl.setEnvironment(SDKConstants.endpoint.production);
//             }

//             ctrl.execute(function () {
//                 const apiResponse = ctrl.getResponse();
//                 const response = new ApiContracts.GetHostedPaymentPageResponse(apiResponse);

//                 if (response != null) {
//                     if (response.getMessages().getResultCode() == ApiContracts.MessageTypeEnum.OK) {
//                         // 7. Return both token and paymentUrl
//                         const token = response.getToken();
//                         const baseUrl = isSandbox 
//                             ? 'https://test.authorize.net/payment/payment' 
//                             : 'https://accept.authorize.net/payment/payment';

//                         resolve({
//                             success: true,
//                             token: token,
//                             paymentUrl: `${baseUrl}?token=${token}`
//                         });
//                     } else {
//                         const messages = response.getMessages();
//                         const errorMsg = messages.getMessage()[0].getText();
//                         const errorCode = messages.getMessage()[0].getCode();
//                         reject(new Error(`Authorize.net Error [${errorCode}]: ${errorMsg}`));
//                     }
//                 } else {
//                     reject(new Error('No response from Authorize.net'));
//                 }
//             });
//         } catch (error) {
//             reject(error);
//         }
//     });
// };


const getHostedPaymentPage = (amount, invoiceNumber, customerEmail) => {
    return new Promise((resolve, reject) => {
        try {
            console.log("🚀 [1] getHostedPaymentPage STARTED");
            console.log("📥 Input:", { amount, invoiceNumber, customerEmail });

            // 1. Authenticate using API Login ID and Transaction Key
            const merchantAuth = getMerchantAuth();
            console.log("🔐 [2] Merchant auth created");

            // 2 & 3. Create transaction request
            const transactionRequestType = new ApiContracts.TransactionRequestType();
            transactionRequestType.setTransactionType(
                ApiContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION
            );
            console.log("📦 [3] Transaction type set");

            // 4. Amount
            transactionRequestType.setAmount(amount.toString());
            console.log("💰 [4] Amount set:", amount);

            // 5. Invoice
            const orderType = new ApiContracts.OrderType();
            orderType.setInvoiceNumber(invoiceNumber);
            orderType.setDescription("Payment for Invoice " + invoiceNumber);
            transactionRequestType.setOrder(orderType);
            console.log("🧾 [5] Order set:", invoiceNumber);

            // Customer
            if (customerEmail) {
                const customerType = new ApiContracts.CustomerDataType();
                customerType.setEmail(customerEmail);
                transactionRequestType.setCustomer(customerType);
                console.log("👤 [6] Customer email set:", customerEmail);
            } else {
                console.log("⚠️ [6] No customer email provided");
            }

            // Settings
            console.log("⚙️ [7] Building settings...");

            const setting1 = new ApiContracts.SettingType();
            setting1.setSettingName("hostedPaymentButtonOptions");
            setting1.setSettingValue('{"text": "Pay"}');

            const setting2 = new ApiContracts.SettingType();
            setting2.setSettingName("hostedPaymentOrderOptions");
            setting2.setSettingValue('{"show": true}');

            const settingListArray = [];
            settingListArray.push(setting1);
            settingListArray.push(setting2);

            console.log("⚙️ [8] Basic settings added");

            // Add the Return URL from .env (to redirect back to React App)
            let baseReturnUrl =
                process.env.PAYMENT_RETURN_URL ||
                "http://localhost:5173/client/payment-return";

            baseReturnUrl = baseReturnUrl.trim()
                .replace(/([^:]\/)\/+/g, "$1")
                .replace("http://api.test", "https://api.test");

            console.log("🌐 [10] Cleaned return URL:", baseReturnUrl);

            if (baseReturnUrl) {
                const settingReturn = new ApiContracts.SettingType();

                const baseUrl = baseReturnUrl.endsWith('/') ? baseReturnUrl.slice(0, -1) : baseReturnUrl;

                const returnPayload = {
                    showReceipt: true, // We can safely show receipt since these are purely UI redirects
                    url: `${baseUrl}/success`,
                    urlText: "Continue to Dashboard",
                    cancelUrl: `${baseUrl}/cancel`,
                    cancelUrlText: "Cancel Payment",
                };

                console.log("📩 [11] Return payload:", returnPayload);

                settingReturn.setSettingName("hostedPaymentReturnOptions");
                settingReturn.setSettingValue(JSON.stringify(returnPayload));

                settingListArray.push(settingReturn);
            }

            const settingList = new ApiContracts.ArrayOfSetting();
            settingList.setSetting(settingListArray);

            console.log("📦 [12] Final settings ready");

            // Request object
            const getRequest =
                new ApiContracts.GetHostedPaymentPageRequest();

            getRequest.setMerchantAuthentication(merchantAuth);
            getRequest.setTransactionRequest(transactionRequestType);
            getRequest.setHostedPaymentSettings(settingList);

            console.log("📡 [13] Request built, sending to Authorize.net");

            const ctrl =
                new ApiControllers.GetHostedPaymentPageController(
                    getRequest.getJSON()
                );

            const isSandbox =
                process.env.AUTHORIZE_ENVIRONMENT === "sandbox";

            console.log("🧪 [14] Environment:", isSandbox ? "SANDBOX" : "PRODUCTION");

            if (isSandbox) {
                ctrl.setEnvironment(SDKConstants.endpoint.sandbox);
            } else {
                ctrl.setEnvironment(SDKConstants.endpoint.production);
            }

            console.log("🚀 [15] Executing request...");

            ctrl.execute(function () {
                console.log("📥 [16] Response received from Authorize.net");

                const apiResponse = ctrl.getResponse();
                const response =
                    new ApiContracts.GetHostedPaymentPageResponse(
                        apiResponse
                    );

                if (response != null) {
                    console.log("📊 [17] Response is not null");

                    const resultCode =
                        response.getMessages().getResultCode();

                    console.log("📊 [18] Result code:", resultCode);

                    if (
                        resultCode ===
                        ApiContracts.MessageTypeEnum.OK
                    ) {
                        const token = response.getToken();

                        console.log("✅ [19] TOKEN GENERATED:", token);

                        const baseUrl = isSandbox
                            ? "https://test.authorize.net/payment/payment"
                            : "https://accept.authorize.net/payment/payment";

                        console.log("🔗 [20] Payment URL ready");

                        resolve({
                            success: true,
                            token: token,
                            paymentUrl: `${baseUrl}?token=${token}`,
                        });

                        console.log("🎉 [21] RESOLVED SUCCESS");
                    } else {
                        const messages =
                            response.getMessages();
                        const errorMsg =
                            messages.getMessage()[0].getText();
                        const errorCode =
                            messages.getMessage()[0].getCode();

                        console.log("❌ [ERROR] Authorize.net rejected request");
                        console.log("❌ Code:", errorCode);
                        console.log("❌ Message:", errorMsg);

                        reject(
                            new Error(
                                `Authorize.net Error [${errorCode}]: ${errorMsg}`
                            )
                        );
                    }
                } else {
                    console.log("❌ [ERROR] Response is NULL");
                    reject(new Error("No response from Authorize.net"));
                }
            });
        } catch (error) {
            console.log("💥 [FATAL ERROR] Exception thrown");
            console.error(error);
            reject(error);
        }
    });
};


/**
 * Get transaction details
 * @param {string} transactionId
 * @returns {Promise<Object>} Transaction details
 */
const getTransactionDetails = async (transactionId) => {
    return new Promise((resolve, reject) => {
        const merchantAuth = getMerchantAuth();

        const request = new ApiContracts.GetTransactionDetailsRequest();
        request.setMerchantAuthentication(merchantAuth);
        request.setTransId(transactionId);

        const controller = new ApiControllers.GetTransactionDetailsController(request.getJSON());
        controller.setEnvironment(getEnvironment());

        controller.execute(() => {
            const response = controller.getResponse();
            const result = new ApiContracts.GetTransactionDetailsResponse(response);

            if (
                result.getMessages().getResultCode() ===
                ApiContracts.MessageTypeEnum.OK
            ) {
                const txn = result.getTransaction();
                resolve({
                    transactionId: txn.getTransId(),
                    transactionType: txn.getTransactionType(),
                    transactionStatus: txn.getTransactionStatus(),
                    responseCode: txn.getResponseCode(),
                    amount: txn.getAuthAmount(),
                    submitTimeUTC: txn.getSubmitTimeUTC(),
                    subscriptionId: txn.getSubscription()?.getId() || null,
                    subscriptionPayNum: txn.getSubscription()?.getPayNum() || null,
                    invoiceNumber: txn.getOrder()?.getInvoiceNumber() || null,
                    customerId: txn.getCustomer()?.getId() || null,
                });
            } else {
                const errorMsg =
                    result.getMessages().getMessage()[0].getText();
                reject(new Error(`Authorize.Net error: ${errorMsg}`));
            }
        });
    });
};

module.exports = {
    getHostedPaymentPageToken,
    createCustomerProfileFromTransaction,
    createARBSubscription,
    cancelARBSubscription,
    getTransactionDetails,
    getHostedPaymentPage,
};
