import Notice from '../../src/modules/notices/notice.model.js';
import Event from '../../src/modules/events/event.model.js';
import EventRsvp from '../../src/modules/events/eventRsvp.model.js';
import ForumCategory from '../../src/modules/forum/forumCategory.model.js';
import ForumTopic from '../../src/modules/forum/forumTopic.model.js';
import ForumReply from '../../src/modules/forum/forumReply.model.js';
import DirectoryProfile from '../../src/modules/directory/directoryProfile.model.js';
import LostFoundItem from '../../src/modules/lostFound/lostFoundItem.model.js';
import Listing from '../../src/modules/marketplace/listing.model.js';
import Business from '../../src/modules/marketplace/business.model.js';
import Conversation from '../../src/modules/chat/conversation.model.js';
import ChatMessage from '../../src/modules/chat/chatMessage.model.js';
import Amenity from '../../src/modules/amenities/amenity.model.js';
import { addDays, addHours, localDateString } from '../../src/common/utils/dates.js';
import { randomCode } from '../../src/common/utils/codes.js';

// Community demo data: an acknowledgement notice, events with RSVPs, forum threads, directory
// opt-ins, lost & found, marketplace listings, a local business and a couple of chats.
export default async function seed(s) {
  const { sid } = s;
  const [admin, manager, ravi, neha, vikram, anita, karan] = await Promise.all(
    ['admin', 'manager', 'resident', 'neha', 'vikram', 'anita', 'karan'].map((n) => s.user(`${n}@demo.test`)),
  );
  if (!admin || !ravi || !neha) return;
  const unitOf = async (email) => (await s.membership(email))?.unit;
  const now = new Date();
  const at = (days, hour) => {
    const d = addDays(now, days);
    return new Date(`${localDateString(d)}T${String(hour).padStart(2, '0')}:00:00+05:30`);
  };

  // notices: one needs acknowledgement, one is scheduled
  await Notice.create([
    {
      society: sid, title: 'Revised parking rules from 1st November', category: 'general', createdBy: admin._id, requiresAck: true, notifiedAt: now,
      body: 'Each flat gets one covered slot. Visitor parking is limited to 4 hours.\nPlease read and acknowledge.', acks: [{ user: neha._id, at: now }], readBy: [neha._id],
    },
    { society: sid, title: 'Society AGM agenda', category: 'meeting', createdBy: admin._id, body: 'The AGM agenda will be shared here.', publishAt: addDays(now, 2) },
  ]);

  // events
  const clubhouse = await Amenity.findOne({ society: sid, name: 'Clubhouse' }).lean();
  const [diwali, cricket, past] = await Event.create([
    {
      society: sid, title: 'Diwali night dinner', category: 'festival', description: 'Dinner, rangoli competition and fireworks on the lawn.',
      venue: 'Clubhouse lawn', amenity: clubhouse?._id, startAt: at(6, 19), endAt: at(6, 23), capacity: 120, maxGuests: 3, ticketPrice: 35000,
      rsvpDeadline: at(4, 22), createdBy: manager?._id || admin._id,
    },
    { society: sid, title: 'Weekend cricket match', category: 'sports', description: 'Block A vs Block B. Bring your own bat!', venue: 'Main ground', startAt: at(2, 7), endAt: at(2, 10), capacity: 22, maxGuests: 0, createdBy: admin._id },
    { society: sid, title: 'Independence Day flag hoisting', category: 'cultural', venue: 'Main gate', startAt: at(-20, 8), endAt: at(-20, 9), createdBy: admin._id, reminderSentAt: at(-21, 8) },
  ]);
  const rsvps = [
    [diwali, ravi, 'resident@demo.test', 2, 'paid'],
    [diwali, neha, 'neha@demo.test', 1, 'pending'],
    [cricket, vikram, 'vikram@demo.test', 0, null],
    [cricket, karan, 'karan@demo.test', 0, null],
    [past, ravi, 'resident@demo.test', 1, null],
  ];
  for (const [ev, user, email, guests, pay] of rsvps) {
    if (!user) continue;
    const headcount = 1 + guests;
    // eslint-disable-next-line no-await-in-loop
    await EventRsvp.create({
      society: sid, event: ev._id, user: user._id, unit: await unitOf(email), response: 'yes', guests, headcount, state: 'confirmed',
      amountDue: headcount * ev.ticketPrice, paymentMode: ev.ticketPrice ? (pay === 'paid' ? 'online' : 'venue') : 'none',
      paymentStatus: ev.ticketPrice ? pay : 'not_required', ticketCode: randomCode(8),
      ...(ev === past ? { checkedInAt: past.startAt, attendedCount: headcount } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    await Event.updateOne({ _id: ev._id }, { $inc: { goingCount: headcount } });
  }

  // forum
  const cats = await ForumCategory.insertMany([
    { society: sid, name: 'General', description: 'Anything about life in the society', order: 1 },
    { society: sid, name: 'Suggestions', description: 'Ideas to make the society better', order: 2 },
    { society: sid, name: 'Help & advice', description: 'Ask neighbours for recommendations', order: 3 },
    { society: sid, name: 'Events & activities', description: 'Plan get-togethers, sports and hobbies', order: 4 },
  ]);
  const t1 = await ForumTopic.create({
    society: sid, category: cats[2]._id, title: 'Good pediatrician near the society?', author: neha._id, body: 'We just moved in. Any recommendations for a pediatrician within 3 km?', replyCount: 2, lastActivityAt: addHours(now, -2), createdAt: addDays(now, -1),
  });
  const t2 = await ForumTopic.create({
    society: sid, category: cats[1]._id, title: 'Can we add a composting unit?', author: vikram?._id || ravi._id, body: 'Wet waste composting would reduce garbage and give us manure for the garden.\nThoughts?', pinned: true, likeCount: 2, likes: [ravi._id, neha._id], lastActivityAt: addHours(now, -5),
  });
  await ForumReply.create([
    { society: sid, topic: t1._id, author: ravi._id, body: 'Dr. Mehta at Sunrise Clinic is great with kids. Open till 8 pm.', likeCount: 1, likes: [neha._id], createdAt: addHours(now, -20) },
    { society: sid, topic: t1._id, author: anita?._id || admin._id, body: '+1 for Dr. Mehta. Book on their website to avoid the wait.', createdAt: addHours(now, -2) },
    { society: sid, topic: t2._id, author: admin._id, body: 'Good idea, we will discuss this at the next committee meeting.' },
  ]);
  await ForumTopic.updateOne({ _id: t2._id }, { replyCount: 1 });

  // directory opt-ins (privacy choices differ on purpose)
  await DirectoryProfile.create([
    { society: sid, user: ravi._id, listed: true, showPhone: true, showProfession: true, profession: 'Software engineer', skills: ['Coding classes for kids'] },
    { society: sid, user: neha._id, listed: true, showProfession: true, profession: 'Doctor (General physician)' },
    ...(anita ? [{ society: sid, user: anita._id, listed: true, showEmail: true }] : []),
    { society: sid, user: admin._id, listed: true, showPhone: true },
  ]);

  // lost & found
  await LostFoundItem.create([
    { society: sid, kind: 'found', title: 'Bunch of keys with a red tag', category: 'keys', location: 'Near the gym', date: localDateString(addDays(now, -1)), postedBy: karan?._id || ravi._id, unit: await unitOf('karan@demo.test'), expiresAt: addDays(now, 29) },
    {
      society: sid, kind: 'lost', title: 'Black Labrador puppy — Bruno', category: 'pet', description: 'Wearing a blue collar. Very friendly.', location: 'Block B park', date: localDateString(now), postedBy: neha._id, unit: await unitOf('neha@demo.test'), expiresAt: addDays(now, 30),
      claims: vikram ? [{ by: vikram._id, message: 'I saw a lab puppy near the back gate an hour ago!' }] : [],
    },
  ]);

  // marketplace
  await Listing.create([
    { society: sid, type: 'sell', title: 'Wooden study table', category: 'furniture', condition: 'good', price: 250000, negotiable: true, description: 'Solid sheesham, 4 ft. Pick up from A-101.', seller: ravi._id, unit: await unitOf('resident@demo.test') },
    { society: sid, type: 'free', title: 'Class 8 NCERT textbooks', category: 'books', condition: 'good', price: 0, seller: neha._id, unit: await unitOf('neha@demo.test') },
    { society: sid, type: 'rent', title: 'Car parking slot available', category: 'property', price: 150000, priceUnit: 'per_month', condition: 'not_applicable', seller: anita?._id || ravi._id, showPhone: true },
    { society: sid, type: 'sell', title: 'Kids bicycle (sold)', category: 'kids', condition: 'fair', price: 120000, seller: vikram?._id || ravi._id, status: 'sold', soldAt: addDays(now, -3) },
  ]);
  await Business.create([
    { society: sid, owner: anita?._id || neha._id, name: "Anita's Home Tiffin", category: 'tiffin', description: 'Homestyle Maharashtrian lunch and dinner.', priceNote: '₹3,200 / month', timings: 'Lunch 12-2, Dinner 7-9', contactPhone: '9000000015', status: 'approved', reviewedBy: admin._id, reviewedAt: now },
    { society: sid, owner: ravi._id, name: 'Weekend coding classes', category: 'tutor', description: 'Scratch and Python for ages 8-14.', priceNote: '₹1,500 / month', status: 'pending' },
  ]);

  // chats: a direct thread and a security-desk thread
  const direct = await Conversation.create({
    society: sid, kind: 'direct', key: `direct:${[String(ravi._id), String(neha._id)].sort().join(':')}`, participants: [ravi._id, neha._id], createdBy: neha._id,
    lastMessage: { text: 'Sure, come by after 6.', sender: ravi._id }, lastMessageAt: addHours(now, -1), unread: { [String(neha._id)]: 1 }, readAt: { [String(ravi._id)]: addHours(now, -1) },
  });
  await ChatMessage.create([
    { society: sid, conversation: direct._id, sender: neha._id, text: 'Hi Ravi, is the study table still available?', context: { type: 'listing', title: 'Wooden study table' }, createdAt: addHours(now, -2) },
    { society: sid, conversation: direct._id, sender: ravi._id, text: 'Sure, come by after 6.', createdAt: addHours(now, -1) },
  ]);
  const desk = await Conversation.create({
    society: sid, kind: 'desk', desk: 'security', key: `desk:security:${ravi._id}`, participants: [ravi._id], createdBy: ravi._id,
    lastMessage: { text: 'Expecting an Amazon delivery around 4 pm, please let them in.', sender: ravi._id }, lastMessageAt: addHours(now, -3), unread: { desk: 1 },
  });
  await ChatMessage.create({ society: sid, conversation: desk._id, sender: ravi._id, text: 'Expecting an Amazon delivery around 4 pm, please let them in.', createdAt: addHours(now, -3) });
}
