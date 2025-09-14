import Coupon from "../model/coupon.model.js";
import Order from "../model/order.model.js";
import { stripe } from "../config/stripe.js";

export const createCheckoutSession = async (req, res) => {
    try {
        const {products , couponCode} = req.body;

        if(!Array.isArray(products) || products.length === 0){
            return res.status(400).json({message:"Invalid or empty products array"})
        }

        let totalAmount = 0;
        const lineItems = products.map((product)=>{
            const amount = Math.round(product.price * 100); // converting to cents
            totalAmount += amount * product.quantity;

            return {
                price_data:{
                    currency:"usd",
                    product_data:{
                        name:product.name,
                        images:[product.image]
                    },
                    unit_amount:amount,
                },
                quantity:product.quantity || 1
            }
        })

        let coupon = null;
        if(couponCode){
            coupon = await Coupon.findOne({code:couponCode , userId:req.user._id , isActive:true});
            if(coupon){
                totalAmount -= Math.round((totalAmount * coupon.discountPercentage ) / 100);
            }
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types:["card"],
            line_items:lineItems,
            mode:"payment",
            success_url:`${process.env.CLIENT_URL}/purchase-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url:`${process.env.CLIENT_URL}/purchase-cancel`,
            discounts:coupon ? [
                {
                    coupon:await createStripeCoupon(coupon.discountPercentage)
                }
            ] :[],
            metadata:{
                userId:req.user._id.toString(),
                couponCode:couponCode || "",
                products:JSON.stringify((p)=>({
                    id:p._id,
                    quantity:p.quantity,
                    price:p.price
                }))
            }
        });

        if(totalAmount >=20000){
            await createNewCoupon(req.user._id);
        }

        return res.status(200).json({sessionId:session.id , totalAmount:totalAmount / 100});
    } catch (error) {
        console.log(error);
        return res.status(500).json({message:"Internal server error"});
    }
}


export const checkOutSuccess = async (req, res) => {
    try {
        const {sessionId} = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if(session.payment_status === "paid"){
            if(session.metadata.couponCode){
                await Coupon.findOneAndUpdate({
                    code:session.metadata.couponCode,
                    userId:session.metadata.userId
                }
                ,{
                    isActive:false
                })
            }
        }

        const products = JSON.parse(session.metadata.products);
        const newOrder = new Order({
            user:session.metadata.userId,
            products:products.map((product)=>({
                product:product.id,
                quantity:product.quantity,
                price:product.price
            })),
            totalAmount:session.amount_total / 100,
            stripeSessionId:sessionId
        })

        await newOrder.save();

        return res.status(200).json({ success:true , message:"Order placed successfully" , orderId:newOrder._id});
    } catch (error) {
        console.log(error);
        return res.status(500).json({message:"Internal server error"});
    }
}



async function createStripeCoupon(discountPercentage) {
    const coupon = await stripe.coupons.create({
        percent_off:discountPercentage,
        duration:"once"
    })

    return coupon.id;
}


async function createNewCoupon(userId) {
    await Coupon.findOneAndDelete({userId});

    const newCoupon = new Coupon({
        code:"GIFT" + Math.random().toString(36).substring(2, 8).toUpperCase(),
        discountPercentage:10,
        expirationDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        userId:userId
    })

    await newCoupon.save();

    return newCoupon;
}