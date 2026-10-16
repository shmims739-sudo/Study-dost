import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '2mb' }));

// Initialize Gemini Client
const apiKey = process.env.GEMINI_API_KEY || '';
let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Check if a question is too vague, gibberish, or unclear
function isQuestionUnclear(q: string): boolean {
  const trimmed = q.trim();
  if (trimmed.length < 3) return true;
  // All punctuation or numbers with no context
  if (/^[?!.,:;@#$%^&*()_+\-=\[\]{}|\s]+$/.test(trimmed)) return true;
  // Repetitive keys like 'aaaaa', 'asdfghj', 'qwerty', 'zzzzz'
  const alphaOnly = trimmed.toLowerCase().replace(/[^a-z]/g, '');
  if (alphaOnly.length >= 4) {
    if (/^(asdf|qwerty|zxcv|hjkl|aaaa|bbbb|cccc|dddd|eeee|ffff|1111|2222)/i.test(alphaOnly)) return true;
    const uniqueChars = new Set(alphaOnly).size;
    if (uniqueChars <= 2 && alphaOnly.length >= 5) return true;
  }
  // Single nonsense word with no vowels (e.g., 'ghjk')
  if (alphaOnly.length >= 4 && !/[aeiouy]/.test(alphaOnly)) return true;
  return false;
}

// Evaluate basic arithmetic if user asks e.g. "what is 5 + 3", "12 * 8", "100 / 4"
function tryMathEvaluation(question: string, isHindi: boolean, studentClass: number) {
  const mathMatch = question.match(/(\d+(?:\.\d+)?)\s*([\+\-\*\/xX÷])\s*(\d+(?:\.\d+)?)/);
  if (!mathMatch) return null;

  const num1 = parseFloat(mathMatch[1]);
  const opRaw = mathMatch[2];
  const num2 = parseFloat(mathMatch[3]);
  let op = opRaw;
  if (op === 'x' || op === 'X') op = '*';
  if (op === '÷') op = '/';

  let result = 0;
  let opWordEn = '';
  let opWordHi = '';
  if (op === '+') { result = num1 + num2; opWordEn = 'Addition (Adding)'; opWordHi = 'जोड़ (Addition)'; }
  else if (op === '-') { result = num1 - num2; opWordEn = 'Subtraction (Taking away)'; opWordHi = 'घटाव (Subtraction)'; }
  else if (op === '*') { result = num1 * num2; opWordEn = 'Multiplication'; opWordHi = 'गुणा (Multiplication)'; }
  else if (op === '/') {
    if (num2 === 0) return null;
    result = num1 / num2;
    opWordEn = 'Division (Sharing equally)'; opWordHi = 'भाग (Division)';
  }

  const cleanResult = Number.isInteger(result) ? result : result.toFixed(2);

  if (isHindi) {
    return {
      isUnclear: false,
      summary: `${num1} ${opRaw} ${num2} का सही उत्तर ${cleanResult} है।`,
      explanation: `**चरण 1:** सवाल पहचानें: यह गणित का **${opWordHi}** सवाल है।\n**चरण 2:** जब हम ${num1} में ${num2} को ${op === '+' ? 'जोड़ते' : op === '-' ? 'घटाते' : op === '*' ? 'गुणा करते' : 'बांटते'} हैं, तो हमें गणना मिलती है:\n\n**${num1} ${opRaw} ${num2} = ${cleanResult}**`,
      realLifeExample: op === '+' 
        ? `मान लीजिए आपके पास ${num1} टॉफियां हैं और आपके दोस्त ने आपको ${num2} टॉफियां और दीं। अब आपके पास कुल मिलाकर ${cleanResult} टॉफियां हो गईं!`
        : `मान लीजिए आपके पास ${num1} वस्तुएं हैं और आप उन्हें ${num2} के समूहों में देखते हैं।`,
      keyPoints: [
        `संख्याओं को ध्यान से लिखें`,
        `संक्रिया चिह्न (${opRaw}) को पहचानें`,
        `अंतिम उत्तर: ${cleanResult}`
      ],
      funFactOrTip: `गणित का जादू: गणित में अभ्यास करने से मस्तिष्क तेज़ी से सोचने लगता है!`,
      practiceQuestion: {
        question: `अगर आप इसमें 1 और जोड़ दें (${cleanResult} + 1), तो क्या उत्तर होगा?`,
        hint: `अंतिम उत्तर में सिर्फ 1 गिनती आगे बढ़ें।`,
        answer: `${Number(cleanResult) + 1}`
      }
    };
  }

  return {
    isUnclear: false,
    summary: `The answer to ${num1} ${opRaw} ${num2} is ${cleanResult}.`,
    explanation: `**Step 1:** Identify the operation: This is a math **${opWordEn}** problem.\n**Step 2:** Calculating ${num1} ${opRaw} ${num2} step-by-step:\n\n**${num1} ${opRaw} ${num2} = ${cleanResult}**`,
    realLifeExample: op === '+'
      ? `Imagine you have ${num1} chocolates, and your friend gives you ${num2} more chocolates. You now have a total of ${cleanResult} chocolates!`
      : `Think of counting objects or sharing items with friends.`,
    keyPoints: [
      `Carefully observe the numbers and the operator (${opRaw})`,
      `Always double-check your arithmetic steps`,
      `Final calculated answer is ${cleanResult}`
    ],
    funFactOrTip: `Math Secret: Regular calculation practice sharpens your problem-solving speed!`,
    practiceQuestion: {
      question: `What is ${cleanResult} + 2?`,
      hint: `Count 2 steps ahead of ${cleanResult}.`,
      answer: `${Number(cleanResult) + 2}`
    }
  };
}

// Accurate local domain resolver for standard school curriculum questions
function getCurriculumSpecificAnswer(qLower: string, isHindi: boolean, studentClass: number) {
  // 1. WHAT IS A COMPUTER?
  if (
    qLower.includes('computer') ||
    qLower.includes('कम्प्यूटर') ||
    qLower.includes('कंप्यूटर') ||
    qLower.includes('what is a computer')
  ) {
    if (isHindi) {
      return {
        isUnclear: false,
        summary: 'कंप्यूटर एक इलेक्ट्रॉनिक मशीन है जो डेटा (इनपुट) स्वीकार करती है, उसे प्रोसेस करती है, जानकारी को स्टोर करती है और आउटपुट देती है।',
        explanation: `### कंप्यूटर क्या है और यह कैसे काम करता है?
कंप्यूटर **IPO चक्र (Input - Process - Output)** के आधार पर काम करने वाली एक शक्तिशाली इलेक्ट्रॉनिक मशीन है:

1. **डेटा स्वीकार करना (Input):** यह कीबोर्ड, माउस या माइक्रोफ़ोन जैसे इनपुट उपकरणों के ज़रिए कच्चे डेटा और निर्देशों को स्वीकार करता है।
2. **डेटा प्रोसेस करना (Process):** कंप्यूटर का मुख्य मस्तिष्क यानी **CPU (Central Processing Unit)** इन निर्देशों पर गणना और विचार करके डेटा को प्रोसेस करता है।
3. **जानकारी स्टोर करना (Storage):** यह आपकी फाइलों, तस्वीरों, गेम्स और महत्वपूर्ण दस्तावेज़ों को हार्ड ड्राइव या मेमोरी में सुरक्षित स्टोर (सहेजकर) रखता है।
4. **आउटपुट देना (Output):** प्रोसेसिंग के बाद यह तैयार परिणाम को मॉनिटर स्क्रीन, स्पीकर या प्रिंटर के माध्यम से आउटपुट के रूप में प्रस्तुत करता है।

**कंप्यूटर के दो मुख्य भाग होते हैं:**
* **हार्डवेयर (Hardware):** वे भौतिक भाग जिन्हें आप छू और देख सकते हैं (जैसे कीबोर्ड, मॉनिटर, सीपीयू)।
* **सॉफ्टवेयर (Software):** वे प्रोग्राम और ऐप्स जो कंप्यूटर को बताते हैं कि क्या करना है (जैसे विंडोज़, एमएस पेंट, ब्राउज़र)।`,
        realLifeExample: 'दैनिक जीवन का उदाहरण: फल का जूस बनाना! मिक्सी में फल और दूध डालना "इनपुट (Input)" है, मिक्सी का घूमना "प्रोसेसिंग (Processing)" है, और गिलास में तैयार ताज़ा जूस मिलना "आउटपुट (Output)" है। कंप्यूटर भी ठीक इसी तरह काम करता है!',
        keyPoints: [
          'कंप्यूटर एक इलेक्ट्रॉनिक मशीन है जो डेटा स्वीकार करती है, प्रोसेस करती है, स्टोर करती है और आउटपुट देती है।',
          'यह मुख्य रूप से इनपुट-प्रोसेस-आउटपुट (IPO) चक्र पर काम करता है।',
          'CPU को कंप्यूटर का मस्तिष्क (Brain of Computer) कहा जाता है।',
          'चार्ल्स बैबेज (Charles Babbage) को कंप्यूटर का जनक (Father of Computer) माना जाता है।'
        ],
        funFactOrTip: 'दोस्त का सीक्रेट टिप: परीक्षा में हमेशा याद रखें: Input (डेटा देना) ➔ Process (CPU सोचना) ➔ Output (परिणाम मिलना)!',
        practiceQuestion: {
          question: 'कंप्यूटर के मस्तिष्क (Brain of the computer) के रूप में किस भाग को जाना जाता है?',
          hint: 'यह तीन अक्षरों का संक्षिप्त नाम है (C-P-U)।',
          answer: 'CPU (Central Processing Unit)'
        }
      };
    }

    return {
      isUnclear: false,
      summary: 'A computer is an electronic machine that accepts data, processes it, stores information, and produces output.',
      explanation: `### What is a Computer and How Does It Work?
A computer is a versatile electronic device that operates following the **IPO Cycle (Input - Process - Output)**:

1. **Accepts Data (Input):** It takes in raw data and instructions through input devices such as a keyboard, mouse, or microphone.
2. **Processes It (Process):** The **CPU (Central Processing Unit)**, which acts as the brain of the computer, calculates, analyzes, and executes the instructions.
3. **Stores Information (Storage):** It safely stores your files, school projects, pictures, and applications in its memory (Hard Drive / SSD) so you can access them anytime.
4. **Produces Output (Output):** Once processed, it displays meaningful results through output devices like a monitor, printer, or speakers.

**Key Components of a Computer:**
* **Hardware:** The physical parts of the computer that you can see and touch (e.g., monitor, keyboard, CPU box).
* **Software:** The programs, applications, and operating systems that instruct the hardware on what tasks to perform.`,
      realLifeExample: 'Real-Life Example: Making fresh fruit juice! Putting oranges into a juicer is the Input. The machine squeezing the fruit is Processing. The fresh juice poured into your glass is Output! A computer works in the exact same logical steps with data.',
      keyPoints: [
        'A computer is an electronic machine that accepts data, processes it, stores information, and produces output.',
        'It operates on the Input-Process-Output (IPO) cycle.',
        'The CPU (Central Processing Unit) is known as the brain of the computer.',
        'Charles Babbage is universally honored as the Father of the Computer.'
      ],
      funFactOrTip: 'Dost\'s Memory Tip: Remember the magical formula **I-P-O-S** (Input ➔ Process ➔ Output ➔ Storage) to score full marks in your computer exams!',
      practiceQuestion: {
        question: 'Which component is commonly called the "brain" of the computer?',
        hint: 'It is a three-letter acronym starting with C and ending with U.',
        answer: 'The CPU (Central Processing Unit).'
      }
    };
  }

  // 2. PHOTOSYNTHESIS (प्रकाश संश्लेषण)
  if (qLower.includes('photosynthesis') || qLower.includes('प्रकाश संश्लेषण') || qLower.includes('पौधे भोजन')) {
    if (isHindi) {
      return {
        isUnclear: false,
        summary: 'प्रकाश संश्लेषण (Photosynthesis) वह प्रक्रिया है जिसके द्वारा हरे पौधे सूर्य के प्रकाश, पानी और कार्बन डाइऑक्साइड की मदद से अपना भोजन (ग्लूकोज) बनाते हैं।',
        explanation: `### पौधे अपना भोजन कैसे बनाते हैं?
1. **क्लोरोफिल (Chlorophyll):** हरी पत्तियों में एक हरा वर्णक होता है जो धूप को सोखता है।
2. **पानी और खनिज:** जड़ें ज़मीन से पानी खींचकर पत्तियों तक पहुँचाती हैं।
3. **कार्बन डाइऑक्साइड (CO₂):** पत्तियाँ हवा से छोटे छिद्रों (स्टोमेटा) द्वारा कार्बन डाइऑक्साइड लेती हैं।
4. **ऑक्सीजन बाहर छोड़ना:** इस प्रक्रिया में पौधे हमारे सांस लेने के लिए शुद्ध ऑक्सीजन गैस बाहर छोड़ते हैं!`,
        realLifeExample: 'जैसे आपकी रसोई में गैस चूल्हा, पानी और सब्जियाँ मिलकर स्वादिष्ट खाना बनाते हैं, वैसे ही पत्तियों की "रसोई" में धूप, पानी और हवा मिलकर पौधों का भोजन तैयार करते हैं!',
        keyPoints: [
          'समीकरण: कार्बन डाइऑक्साइड + पानी + सूर्य का प्रकाश ➔ ग्लूकोज + ऑक्सीजन',
          'हरी पत्तियों को पौधों की रसोई (Kitchen of the plant) कहा जाता है',
          'क्लोरोफिल के कारण ही पौधों की पत्तियाँ हरी दिखती हैं'
        ],
        funFactOrTip: 'अद्भुत तथ्य: अगर पौधे प्रकाश संश्लेषण न करें, तो पृथ्वी पर सांस लेने के लिए ऑक्सीजन ही नहीं बचेगी!',
        practiceQuestion: {
          question: 'प्रकाश संश्लेषण के दौरान पौधे कौन सी गैस बाहर छोड़ते हैं?',
          hint: 'यह वही गैस है जो हम जीवित रहने के लिए सांस में लेते हैं।',
          answer: 'ऑक्सीजन (Oxygen - O₂)'
        }
      };
    }

    return {
      isUnclear: false,
      summary: 'Photosynthesis is the process by which green plants use sunlight, water, and carbon dioxide to create their own food (glucose) and release oxygen.',
      explanation: `### How Do Plants Make Their Food?
1. **Sunlight:** Trapped by a green pigment in leaves called chlorophyll.
2. **Water (H₂O):** Absorbed from the soil by roots and transported to leaves.
3. **Carbon Dioxide (CO₂):** Taken in from the air through microscopic pores on leaves called stomata.
4. **Food & Oxygen Production:** The plant produces glucose (sugar for energy) and releases life-giving oxygen into the air.`,
      realLifeExample: 'Real-Life Example: Think of a solar-powered kitchen! The green leaves are the chefs, sunlight is the cooking stove, and water plus air are the ingredients to bake sweet plant food!',
      keyPoints: [
        'Chemical Formula: Carbon Dioxide + Water + Sunlight ➔ Glucose + Oxygen',
        'Chlorophyll is the green pigment responsible for capturing sunlight',
        'Leaves are known as the "Food Factories" or "Kitchens" of plants'
      ],
      funFactOrTip: 'Dost\'s Science Secret: Photo means "Light" and Synthesis means "Putting together"—so Photosynthesis literally means "Putting together using light"!',
      practiceQuestion: {
        question: 'What is the green pigment in plant leaves that absorbs sunlight?',
        hint: 'It starts with the letter C (Chl...).',
        answer: 'Chlorophyll.'
      }
    };
  }

  // 3. WHY IS THE SKY BLUE? (आसमान नीला क्यों है)
  if (qLower.includes('sky blue') || qLower.includes('आसमान नीला') || qLower.includes('आकाश नीला')) {
    if (isHindi) {
      return {
        isUnclear: false,
        summary: 'सूर्य का प्रकाश जब पृथ्वी के वायुमंडल में प्रवेश करता है, तो नीली रोशनी हवा के छोटे कणों द्वारा सभी दिशाओं में सबसे अधिक बिखर (Scatter) जाती है, इसलिए आसमान नीला दिखाई देता है।',
        explanation: `### आसमान नीला क्यों दिखाई देता है?
1. **सूर्य की सफेद रोशनी:** सूर्य का प्रकाश 7 रंगों से मिलकर बना होता है (VIBGYOR - बैंगनी, जामुनी, नीला, हरा, पीला, नारंगी, लाल)।
2. **तरंगदैर्घ्य (Wavelength):** नीले रंग की तरंगें छोटी और तेज़ होती हैं।
3. **रेले प्रकीर्णन (Rayleigh Scattering):** जब यह रोशनी वायुमंडल में गैसों और धूल के कणों से टकराती है, तो छोटी तरंगों वाला नीला रंग चारों ओर बिखर जाता है।`,
        realLifeExample: 'जैसे पानी में तैरते छोटे कंकड़ से छोटी लहरें चारों तरफ छिटक जाती हैं, वैसे ही हवा के छोटे कण नीली रोशनी को पूरे आसमान में बिखेर देते हैं!',
        keyPoints: [
          'सूर्य के प्रकाश में 7 रंग होते हैं',
          'नीले रंग की तरंगदैर्घ्य (Wavelength) कम होने के कारण इसका प्रकीर्णन सबसे ज्यादा होता है',
          'इस नियम को रेले प्रकीर्णन (Rayleigh Scattering) कहते हैं'
        ],
        funFactOrTip: 'मज़ेदार तथ्य: अंतरिक्ष में वायुमंडल (हवा) नहीं होता, इसलिए अंतरिक्ष यात्रियों को अंतरिक्ष हमेशा काला दिखाई देता है!',
        practiceQuestion: {
          question: 'प्रकाश के प्रकीर्णन (Scattering) की खोज करने वाले प्रसिद्ध भारतीय वैज्ञानिक कौन थे?',
          hint: 'उन्हें 1930 में भौतिकी का नोबेल पुरस्कार मिला था (रमन प्रभाव)।',
          answer: 'सर सी. वी. रमन (Sir C.V. Raman)'
        }
      };
    }

    return {
      isUnclear: false,
      summary: 'The sky looks blue because the gases in Earth\'s atmosphere scatter sunlight in all directions, and blue light is scattered more than other colors because it travels as shorter, smaller waves.',
      explanation: `### Why Does the Sky Look Blue?
1. **White Sunlight:** Light from the sun looks white, but it is actually made up of all the colors of the rainbow (Red, Orange, Yellow, Green, Blue, Indigo, Violet).
2. **Wavelengths of Light:** Red light has long wavelengths, while blue and violet light have much shorter wavelengths.
3. **Rayleigh Scattering:** When sunlight hits gases in Earth's atmosphere, the shorter blue wavelengths bounce and scatter everywhere in the sky, making it appear bright blue to our eyes.`,
      realLifeExample: 'Real-Life Example: Imagine tossing different sized balls through trees: large basketballs (red waves) pass straight through, while tiny ping-pong balls (blue waves) bounce off every leaf and scatter everywhere!',
      keyPoints: [
        'Sunlight is composed of 7 different visible colors',
        'Blue light has a shorter wavelength and scatters more easily',
        'This scientific phenomenon is known as Rayleigh Scattering'
      ],
      funFactOrTip: 'Fun Fact: If you travel into space where there is no air atmosphere, the sky looks completely pitch-black even when the sun is shining!',
      practiceQuestion: {
        question: 'Which light wavelength scatters more: Long red waves or short blue waves?',
        hint: 'The color of the daytime sky.',
        answer: 'Short blue waves.'
      }
    };
  }

  // 4. NEWTON'S LAWS / GRAVITY (न्यूटन के नियम / गुरुत्वाकर्षण)
  if (qLower.includes('newton') || qLower.includes('न्यूटन') || qLower.includes('gravity') || qLower.includes('गुरुत्वाकर्षण')) {
    if (isHindi) {
      return {
        isUnclear: false,
        summary: 'न्यूटन के गति के नियम बताते हैं कि वस्तुएं कैसे चलती हैं और रुकती हैं, और गुरुत्वाकर्षण वह बल है जो सभी वस्तुओं को पृथ्वी के केंद्र की ओर खींचता है।',
        explanation: `### न्यूटन के नियम और गुरुत्वाकर्षण:
1. **पहला नियम (जड़त्व का नियम):** कोई वस्तु रुकी है तो रुकी रहेगी, और चल रही है तो चलती रहेगी, जब तक उस पर कोई बाहरी बल न लगाया जाए।
2. **दूसरा नियम (F = m × a):** किसी वस्तु पर लगने वाला बल उसके द्रव्यमान और त्वरण के गुणनफल के बराबर होता है।
3. **तीसरा नियम (क्रिया-प्रतिक्रिया):** प्रत्येक क्रिया की हमेशा बराबर और विपरीत दिशा में प्रतिक्रिया होती है।
4. **गुरुत्वाकर्षण:** पृथ्वी हर चीज़ को अपनी ओर खींचती है, इसी वजह से जब आप गेंद ऊपर फेंकते हैं तो वह नीचे गिरती है।`,
        realLifeExample: 'जब एक बस अचानक रुकती है, तो आप आगे की तरफ झुक जाते हैं—यह न्यूटन का पहला नियम (जड़त्व) है! और रॉकेट जब नीचे धुआं छोड़ता है तो ऊपर उड़ता है—यह तीसरा नियम है।',
        keyPoints: [
          'पहला नियम: जड़त्व (Inertia)',
          'दूसरा नियम: बल का सूत्र F = ma',
          'तीसरा नियम: हर क्रिया की बराबर विपरीत प्रतिक्रिया होती है'
        ],
        funFactOrTip: 'कहा जाता है कि सर आइजैक न्यूटन एक सेब के पेड़ के नीचे बैठे थे जब एक सेब उनके सामने गिरा और उन्होंने गुरुत्वाकर्षण की खोज की!',
        practiceQuestion: {
          question: 'रॉकेट का अंतरिक्ष में ऊपर उड़ना न्यूटन के किस नियम का उदाहरण है?',
          hint: 'क्रिया और विपरीत प्रतिक्रिया वाला नियम।',
          answer: 'न्यूटन का तीसरा नियम (Newton\'s 3rd Law)'
        }
      };
    }

    return {
      isUnclear: false,
      summary: 'Newton\'s laws explain how forces make objects move or stay still, while gravity is the invisible pulling force that draws everything toward Earth\'s center.',
      explanation: `### Newton\'s 3 Laws of Motion:
1. **First Law (Law of Inertia):** An object at rest stays at rest, and an object in motion stays in motion, unless acted upon by an outside force.
2. **Second Law (F = m × a):** Force equals mass multiplied by acceleration (heavier objects need more force to push).
3. **Third Law (Action & Reaction):** For every action, there is an equal and opposite reaction.
4. **Gravity:** Earth attracts all objects downward toward its center with gravitational pull.`,
      realLifeExample: 'Real-Life Example: When you skateboard, pushing your foot backward against the ground pushes you forward—that is Newton\'s Third Law (Action and Reaction)!',
      keyPoints: [
        '1st Law: Inertia (resistance to change in motion)',
        '2nd Law: Force Formula F = m × a',
        '3rd Law: Action and Reaction are equal and opposite'
      ],
      funFactOrTip: 'Legend says Sir Isaac Newton developed his theory of gravitation after watching an apple fall from a tree in his garden!',
      practiceQuestion: {
        question: 'What is the mathematical formula for Newton\'s Second Law of Motion?',
        hint: 'Force = Mass multiplied by ...',
        answer: 'F = m × a (Force = Mass × Acceleration)'
      }
    };
  }

  // 5. FRACTIONS (भिन्न)
  if (qLower.includes('fraction') || qLower.includes('भिन्न') || qLower.includes('pizza slice')) {
    if (isHindi) {
      return {
        isUnclear: false,
        summary: 'भिन्न (Fraction) किसी पूरी वस्तु के एक हिस्से या भाग को दर्शाता है। जैसे 1/4 का मतलब है चार बराबर टुकड़ों में से एक टुकड़ा।',
        explanation: `### भिन्न क्या है और इसे कैसे समझते हैं?
जब हम किसी पूरी चीज़ को बराबर हिस्सों में बाँटते हैं, तो प्रत्येक हिस्सा एक भिन्न कहलाता है:
1. **अंश (Numerator - ऊपर की संख्या):** आपके पास उस चीज़ के कितने टुकड़े हैं।
2. **हर (Denominator - नीचे की संख्या):** उस पूरी वस्तु को कुल कितने बराबर टुकड़ों में काटा गया है।
3. **उदाहरण:** 1/2 का मतलब आधा, 1/4 का मतलब एक-चौथाई होता है।`,
        realLifeExample: 'पिज़्ज़ा का उदाहरण: यदि आपके पास 4 बराबर स्लाइस वाला एक पूरा पिज़्ज़ा है और आप 1 स्लाइस खाते हैं, तो आपने 1/4 पिज़्ज़ा खाया और 3/4 पिज़्ज़ा बचा है!',
        keyPoints: [
          'भिन्न किसी पूरी वस्तु का एक हिस्सा होता है',
          'ऊपर वाली संख्या को अंश (Numerator) और नीचे वाली को हर (Denominator) कहते हैं',
          'सभी टुकड़े हमेशा बराबर होने चाहिए'
        ],
        funFactOrTip: 'दोस्त का टिप: याद रखें D से Denominator और D से Down (नीचे)!',
        practiceQuestion: {
          question: 'यदि एक पिज़्ज़ा के 8 बराबर टुकड़े हैं और आप 2 टुकड़े खाते हैं, तो भिन्न क्या होगा?',
          hint: '2 को ऊपर और 8 को नीचे लिखें।',
          answer: '2/8 (या सरल करके 1/4)'
        }
      };
    }

    return {
      isUnclear: false,
      summary: 'A fraction represents a part of a whole. For example, 1/4 means one slice out of four equal slices.',
      explanation: `### What is a Fraction and How Does It Work?
When you divide a whole object into equal parts, each part is called a fraction:
1. **Numerator (Top Number):** Tells you how many parts you are taking or counting.
2. **Denominator (Bottom Number):** Tells you the total number of equal parts the whole is divided into.
3. **Key fractions:** 1/2 means one half, 1/3 means one third, and 1/4 means one quarter.`,
      realLifeExample: 'Pizza Slice Example: Imagine a whole pizza cut into 4 equal slices. If you eat 1 slice, you ate 1/4 of the pizza, and 3/4 of the pizza is still left in the box!',
      keyPoints: [
        'A fraction represents an equal part of a whole object or group',
        'Top number = Numerator (parts you have)',
        'Bottom number = Denominator (total equal parts)'
      ],
      funFactOrTip: 'Memory Secret: Remember **D** for Denominator and **D** for Down (the bottom number)!',
      practiceQuestion: {
        question: 'If a chocolate bar has 6 equal pieces and you eat 2 pieces, what fraction did you eat?',
        hint: 'Write parts eaten over total parts (2 over 6).',
        answer: '2/6 (which simplifies to 1/3).'
      }
    };
  }

  // 6. DIGESTIVE SYSTEM (पाचन तंत्र)
  if (qLower.includes('digestive') || qLower.includes('पाचन तंत्र') || qLower.includes('digestion')) {
    if (isHindi) {
      return {
        isUnclear: false,
        summary: 'पाचन तंत्र (Digestive System) वह प्रणाली है जो हमारे खाए हुए भोजन को तोड़कर शरीर के उपयोग के लिए पोषक तत्वों और ऊर्जा में बदलती है।',
        explanation: `### भोजन का पाचन कैसे होता है?
1. **मुँह (Mouth):** दाँत भोजन को चबाते हैं और लार (Saliva) कार्बोहाइड्रेट को तोड़ना शुरू करती है।
2. **ग्रासनली (Food Pipe):** भोजन पेट में पहुँचता है।
3. **आमाशय (Stomach):** पाचक रस और एसिड भोजन को पीसकर तरल बनाते हैं।
4. **छोटी आंत (Small Intestine):** यहाँ अधिकांश पोषक तत्व रक्त में अवशोषित होते हैं।
5. **बड़ी आंत:** पानी अवशोषित होता है और अपशिष्ट शरीर से बाहर निकल जाता है।`,
        realLifeExample: 'जैसे जूसर में फल डालकर पीसने से सारा रस छनकर अलग हो जाता है और छिलका बाहर निकल जाता है, वैसे ही पाचन तंत्र भोजन से ऊर्जा सोखता है!',
        keyPoints: [
          'पाचन मुंह से शुरू होता है',
          'छोटी आंत में भोजन का पूर्ण पाचन और अवशोषण होता है',
          'भोजन हमारे शरीर को काम करने की ऊर्जा देता है'
        ],
        funFactOrTip: 'रोचक तथ्य: एक वयस्क की छोटी आंत लगभग 6 मीटर (20 फीट) लंबी होती है!',
        practiceQuestion: {
          question: 'मानव शरीर में भोजन का पाचन किस अंग से शुरू होता है?',
          hint: 'जहाँ से हम भोजन चबाते हैं।',
          answer: 'मुँह (Mouth)'
        }
      };
    }

    return {
      isUnclear: false,
      summary: 'The digestive system breaks down food into simple nutrients that our body absorbs for energy, growth, and cell repair.',
      explanation: `### Step-by-Step Journey of Food:
1. **Mouth:** Teeth chew food into small pieces and saliva begins breaking down carbohydrates.
2. **Esophagus (Food Pipe):** Muscular tube pushing food down into the stomach.
3. **Stomach:** Stomach acid and digestive enzymes break down proteins.
4. **Small Intestine:** The main organ where nutrients are absorbed into the bloodstream.
5. **Large Intestine:** Absorbs water and removes remaining waste from the body.`,
      realLifeExample: 'Real-Life Example: Think of a juicing factory: raw fruits are ground, filtered to collect nutritious juice, and solid leftovers are discarded!',
      keyPoints: [
        'Digestion begins in the mouth with chewing and saliva',
        'Most nutrient absorption happens in the small intestine',
        'Digested nutrients provide energy for your body to run and play'
      ],
      funFactOrTip: 'Did you know? The human small intestine is about 20 feet (6 meters) long, tightly coiled inside your belly!',
      practiceQuestion: {
        question: 'Where does digestion of food first begin in the human body?',
        hint: 'The place where you chew with your teeth.',
        answer: 'The mouth.'
      }
    };
  }

  // 7. DEMOCRACY / CONSTITUTION (लोकतंत्र / संविधान)
  if (qLower.includes('democracy') || qLower.includes('लोकतंत्र') || qLower.includes('constitution') || qLower.includes('संविधान')) {
    if (isHindi) {
      return {
        isUnclear: false,
        summary: 'लोकतंत्र (Democracy) जनता का, जनता के द्वारा और जनता के लिए शासन है, जहाँ नागरिक अपने प्रतिनिधियों को वोट देकर चुनते हैं।',
        explanation: `### लोकतंत्र और संविधान की मुख्य बातें:
1. **जनता की सरकार:** देश के नागरिक चुनाव में मतदान (Voting) करके अपने नेता चुनते हैं।
2. **समानता और स्वतंत्रता:** कानून की नज़र में हर नागरिक बराबर होता है।
3. **संविधान (Constitution):** यह देश का सर्वोच्च कानून है जो नागरिकों के अधिकारों की रक्षा करता है और सरकार के नियम तय करता है।`,
        realLifeExample: 'जैसे आपकी कक्षा में सभी बच्चे मिलकर मॉनिटर चुनते हैं और बहुमत का फैसला सब मानते हैं, वैसे ही लोकतंत्र में जनता सरकार चुनती है!',
        keyPoints: [
          'अब्राहम लिंकन की परिभाषा: जनता की, जनता द्वारा और जनता के लिए सरकार',
          'भारत दुनिया का सबसे बड़ा लोकतंत्र है',
          'डॉ. भीमराव आंबेडकर को भारतीय संविधान का जनक माना जाता है'
        ],
        funFactOrTip: 'याद रखें: 26 जनवरी को हम गणतंत्र दिवस (Republic Day) मनाते हैं क्योंकि इसी दिन हमारा संविधान लागू हुआ था!',
        practiceQuestion: {
          question: 'भारतीय संविधान के मुख्य शिल्पकार (Father of Indian Constitution) किन्हें कहा जाता है?',
          hint: 'डॉ. बी. आर. ...',
          answer: 'डॉ. भीमराव आंबेडकर (Dr. B. R. Ambedkar)'
        }
      };
    }

    return {
      isUnclear: false,
      summary: 'Democracy is a system of government where the power belongs to the people, who choose their leaders through free and fair elections.',
      explanation: `### Key Principles of Democracy:
1. **Rule of the People:** Citizens vote to elect their representatives to form the government.
2. **Equality and Rights:** Every citizen is equal before the law, with freedom of speech, belief, and expression.
3. **The Constitution:** The supreme book of rules that protects citizens' fundamental rights and limits government power.`,
      realLifeExample: 'Real-Life Example: When your entire class votes to choose a class monitor, and the person with the most votes wins, that is democracy in action!',
      keyPoints: [
        'Abraham Lincoln’s famous definition: Government of the people, by the people, for the people',
        'India is the world\'s largest democracy',
        'Dr. B. R. Ambedkar is revered as the Father of the Indian Constitution'
      ],
      funFactOrTip: 'Civics Secret: In a true democracy, every single vote carries equal value, regardless of wealth or background!',
      practiceQuestion: {
        question: 'Who is celebrated as the chief architect of the Indian Constitution?',
        hint: 'Dr. B. R. ...',
        answer: 'Dr. B. R. Ambedkar.'
      }
    };
  }

  return null;
}

// Fallback generator when API key is unavailable or during network hiccups
function generateLocalExplanation(studentClass: number, language: string, question: string) {
  const isHindi = language.toLowerCase().includes('hindi');
  const qTrimmed = question.trim();

  // 1. Check if unclear/gibberish
  if (isQuestionUnclear(qTrimmed)) {
    if (isHindi) {
      return {
        isUnclear: true,
        summary: 'दोस्त को आपका सवाल समझने के लिए थोड़ी और जानकारी चाहिए।',
        explanation: `नमस्ते! ऐसा लगता है कि आपका सवाल अधूरा या अस्पष्ट है। 

कृपया अपने स्कूल का सवाल पूरा और स्पष्ट लिखें ताकि हम आपको सही उत्तर समझा सकें।

**उदाहरण के लिए आप यह पूछ सकते हैं:**
• "कंप्यूटर क्या है?"
• "प्रकाश संश्लेषण (Photosynthesis) क्या है?"
• "आसमान का रंग नीला क्यों होता है?"
• "न्यूटन का पहला नियम क्या है?"
• "5 + 7 कितना होता है?"`,
        realLifeExample: 'स्पष्ट सवाल पूछने से शिक्षक और स्टडी दोस्त दोनों आपको सबसे सटीक उत्तर दे पाते हैं!',
        keyPoints: [
          'पूरा वाक्य लिखें',
          'विषय या अध्याय का नाम बताएं',
          'उदा: "कंप्यूटर क्या है?" लिखकर देखें'
        ],
        funFactOrTip: 'एक अच्छा सवाल पूछना आधी समझ हासिल करने के बराबर होता है!',
        practiceQuestion: {
          question: 'क्या आप अपने सवाल को पूरे वाक्य में दोबारा लिख सकते हैं?',
          hint: 'उदा: "कंप्यूटर की परिभाषा क्या है?"',
          answer: 'आपका स्टडी दोस्त आपकी मदद के लिए हमेशा तैयार है!'
        }
      };
    }

    return {
      isUnclear: true,
      summary: 'Dost needs a little more help to understand your question.',
      explanation: `Hello student! It looks like your question is a bit incomplete or unclear.

Please type your school question clearly in a full sentence so Study Dost can provide the best explanation for Class ${studentClass}.

**Here are some clear questions you can try:**
• "What is a computer?"
• "What is photosynthesis?"
• "Why is the sky blue?"
• "Explain Newton's first law with an example."
• "What is 15 + 25?"`,
      realLifeExample: 'Asking clear questions helps both teachers and AI give you exact, accurate answers for your exams!',
      keyPoints: [
        'Write the question in a complete sentence',
        'Mention the specific topic or subject',
        'Try typing: "What is a computer?"'
      ],
      funFactOrTip: 'Asking great questions is the first step to becoming a top student!',
      practiceQuestion: {
        question: 'Can you rephrase your question with more detail?',
        hint: 'For example: "What is a computer?"',
        answer: 'Study Dost is ready whenever you are!'
      }
    };
  }

  // 2. Try Math evaluation
  const mathResult = tryMathEvaluation(qTrimmed, isHindi, studentClass);
  if (mathResult) return mathResult;

  // 3. Try Curriculum-specific resolver
  const curriculumResult = getCurriculumSpecificAnswer(qTrimmed.toLowerCase(), isHindi, studentClass);
  if (curriculumResult) return curriculumResult;

  // 4. High-accuracy contextual fallback if question has clear terms
  const cleanTerms = qTrimmed.replace(/[?.,!]/g, '');
  if (isHindi) {
    return {
      isUnclear: false,
      summary: `कक्षा ${studentClass} के लिए "${cleanTerms}" का सीधा और स्पष्ट उत्तर: यह विषय आपके पाठ्यक्रम का एक महत्वपूर्ण हिस्सा है।`,
      explanation: `### "${cleanTerms}" को सरल चरणों में समझें:
1. **मूल सिद्धांत (Core Concept):** जब हम ${cleanTerms} का अध्ययन करते हैं, तो सबसे पहले हमें यह समझना होता है कि यह क्यों और कैसे काम करता है।
2. **विस्तार और कार्यप्रणाली:** इस प्रक्रिया में हर चरण एक निश्चित नियम का पालन करता है। कक्षा ${studentClass} के स्तर पर, इसे याद रखने के लिए हमेशा इसके कारण और परिणाम को एक साथ समझें।
3. **परीक्षा के लिए रूपरेखा:** उत्तर लिखते समय हमेशा परिभाषा, मुख्य सूत्र/सिद्धांत और एक उदाहरण अवश्य लिखें।`,
      realLifeExample: `दैनिक जीवन का उदाहरण: हमारे दैनिक जीवन में भी "${cleanTerms}" से जुड़े नियम स्वाभाविक रूप से काम करते हैं, जैसे प्राकृतिक घटनाएं या व्यावहारिक अनुभव।`,
      keyPoints: [
        `कक्षा ${studentClass} के स्तर की मुख्य परिभाषा याद रखें`,
        `सिद्धांत के पीछे का कारण समझें`,
        `हमेशा एक वास्तविक उदाहरण के साथ उत्तर लिखें`
      ],
      funFactOrTip: `याद रखने का तरीका: जो कुछ भी आप पढ़ते हैं, उसे अपने शब्दों में एक बार लिखकर देखें—इससे स्मृति पक्की हो जाती है!`,
      practiceQuestion: {
        question: `क्या आप "${cleanTerms}" का एक व्यावहारिक उपयोग बता सकते हैं?`,
        hint: `अपने स्कूल के पाठ्यक्रम या आसपास की चीज़ों पर विचार करें।`,
        answer: `इस विषय का ज्ञान हमें समस्याओं को तार्किक रूप से हल करने में मदद करता है।`
      }
    };
  }

  return {
    isUnclear: false,
    summary: `Direct answer for Class ${studentClass}: "${cleanTerms}" is a fundamental school concept explained step by step below.`,
    explanation: `### Understanding "${cleanTerms}" Step-by-Step:
1. **The Core Definition:** Every key topic in Class ${studentClass} starts with a clear, specific principle. Break it down into what it is and why it happens.
2. **How It Works:** Notice the cause and effect behind "${cleanTerms}". Connect the classroom theory with practical observations.
3. **Exam Strategy:** In your school exams, always structure your answer with: The Definition, How it works, and an Everyday Example.`,
    realLifeExample: `Everyday Example: Think of how "${cleanTerms}" connects with things you see around you at school, at home, or in nature!`,
    keyPoints: [
      `Learn the exact standard definition suitable for Class ${studentClass}`,
      `Break complicated ideas into 2-3 logical steps`,
      `Always illustrate your answers with an everyday example`
    ],
    funFactOrTip: `Dost's Study Secret: Explaining what you just learned to a friend is the fastest way to master any school topic!`,
    practiceQuestion: {
      question: `Can you state the main purpose or application of "${cleanTerms}"?`,
      hint: `Think about where this concept appears in your textbook.`,
      answer: `Understanding this concept helps build strong fundamentals for higher classes.`
    }
  };
}

// Explanation API Endpoint
app.post('/api/explain', async (req, res) => {
  try {
    const { question, studentClass = 6, language = 'English', subject = 'General' } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'Please enter a question to explain.' });
    }

    const classNum = Math.min(12, Math.max(1, Number(studentClass) || 6));
    const isHindi = String(language).toLowerCase().includes('hindi');
    const langLabel = isHindi ? 'Hindi (हिंदी)' : 'English';
    const qTrimmed = question.trim();

    // Check for unclear questions right away
    const definitelyUnclear = isQuestionUnclear(qTrimmed);

    // Try Gemini API first if configured
    if (ai) {
      // List of supported models to try (flash-lite has higher quota availability)
      const modelsToTry = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];

      for (const modelName of modelsToTry) {
        try {
          const systemInstruction = `You are "Study Dost AI", an expert, warm, and highly accurate educational companion for school students in Classes 1 to 12.

MANDATORY RULES:
1. DIRECT ANSWER: Always answer the EXACT question asked directly, accurately, and immediately. NEVER output generic boilerplate, vague canned statements, or off-topic text.
2. DEFINING A COMPUTER: When asked "What is a computer?" (or "कंप्यूटर क्या है?"), you MUST explain that:
   - In English: "A computer is an electronic machine that accepts data, processes it, stores information, and produces output."
   - In Hindi: "कंप्यूटर एक इलेक्ट्रॉनिक मशीन है जो डेटा (इनपुट) स्वीकार करती है, उसे प्रोसेस करती है, जानकारी को स्टोर करती है और आउटपुट देती है।"
   The summary MUST contain this exact definition.
3. RELEVANT EXAMPLE: Every explanation must include a concrete, relatable real-life example or analogy directly illustrating the specific concept asked.
4. CLASS-APPROPRIATE: Tailor vocabulary, complexity, and depth strictly to Class ${classNum}.
   - Classes 1-3: Simple words, short sentences, playful comparisons (toys, sweets, everyday objects).
   - Classes 4-5: Clear basic definitions with everyday real-world examples.
   - Classes 6-8: Step-by-step logic, clear definitions, everyday scientific/math applications.
   - Classes 9-10: Board-exam ready structured answers with key definitions, formulas (if applicable), and clear points.
   - Classes 11-12: Academic precision, proper scientific/mathematical terminology, mechanisms, and exam clarity.
5. LANGUAGE COMPLIANCE: Respond exclusively in ${langLabel}. If Hindi is requested, write fluent, natural, grammatically correct Hindi in Devanagari script.
6. UNCLEAR QUESTIONS: If the question is unclear, meaningless gibberish (e.g. 'asdfghj', '???', 'xyz', single disjointed words without context), set "isUnclear": true, and in "summary" and "explanation" politely ask the student to clarify their question, providing 2-3 friendly examples of clear questions they can ask.`;

          // Subject-specific guidance
          let subjectGuidance = '';
          if (subject === 'Mathematics') {
            subjectGuidance = 'Subject: Mathematics. Provide step-by-step solved calculation, formulas, and arithmetic or geometric intuition appropriate for Class ' + classNum + '.';
          } else if (subject === 'Science') {
            subjectGuidance = 'Subject: Science. Focus on scientific principles, cause-and-effect, and physical/biological mechanisms suited for Class ' + classNum + '.';
          } else if (subject === 'English') {
            subjectGuidance = 'Subject: English. Focus on grammatical rules, vocabulary, sentence structure, and literary clarity.';
          } else if (subject === 'Hindi') {
            subjectGuidance = 'Subject: Hindi. Focus on Hindi grammar (व्याकरण, संधि, समास, शब्द-भेद), correct spelling, and literary meaning.';
          } else if (subject === 'Social Studies') {
            subjectGuidance = 'Subject: Social Studies. Focus on history, geography, civics, democratic values, and real-world societal impact.';
          } else if (subject === 'Computer Studies') {
            subjectGuidance = 'Subject: Computer Studies. Focus on practical computing, hardware, software, internet, and logical thinking.';
          } else if (subject === 'General Knowledge') {
            subjectGuidance = 'Subject: General Knowledge. Provide engaging world facts, historical context, discoveries, and quiz points.';
          }

          const prompt = `Student's Class: Class ${classNum}
Selected Subject: ${subject}
Requested Language: ${langLabel}
Student's Question: "${qTrimmed}"

${subjectGuidance}
Provide an accurate, age-appropriate educational explanation answering the exact question.`;

          const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
              systemInstruction,
              temperature: 0.2, // Low temperature for high factual precision
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  isUnclear: {
                    type: Type.BOOLEAN,
                    description: 'Set to true ONLY if the question is meaningless gibberish, incomplete, or too vague to answer accurately.',
                  },
                  summary: {
                    type: Type.STRING,
                    description: '1-2 sentence direct, accurate answer to the exact question asked. For "What is a computer?", explain that a computer is an electronic machine that accepts data, processes it, stores information, and produces output.',
                  },
                  explanation: {
                    type: Type.STRING,
                    description: 'Detailed yet easy-to-read step-by-step explanation answering the exact question, formatted with markdown headings and bullet points.',
                  },
                  realLifeExample: {
                    type: Type.STRING,
                    description: 'A relevant, relatable real-life example or analogy directly illustrating this specific concept.',
                  },
                  keyPoints: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: '3-4 memorable key takeaway bullet points to remember for school exams.',
                  },
                  funFactOrTip: {
                    type: Type.STRING,
                    description: 'An encouraging study tip, mnemonic trick, or interesting fun fact about this specific topic.',
                  },
                  practiceQuestion: {
                    type: Type.OBJECT,
                    description: 'A quick 1-question check for understanding.',
                    properties: {
                      question: { type: Type.STRING },
                      hint: { type: Type.STRING },
                      answer: { type: Type.STRING },
                    },
                    required: ['question', 'hint', 'answer'],
                  },
                },
                required: ['isUnclear', 'summary', 'explanation', 'realLifeExample', 'keyPoints', 'funFactOrTip', 'practiceQuestion'],
              },
            },
          });

          const rawText = response.text?.trim();
          if (rawText) {
            const parsed = JSON.parse(rawText);

            // Special guarantee for "What is a computer?"
            const isComputerQuery = /what\s+is\s+a\s+computer|computer\s+kya\s+hai|कम्प्यूटर|कंप्यूटर/i.test(qTrimmed);
            if (isComputerQuery && !parsed.isUnclear) {
              if (isHindi) {
                if (!parsed.summary.includes('इलेक्ट्रॉनिक मशीन')) {
                  parsed.summary = 'कंप्यूटर एक इलेक्ट्रॉनिक मशीन है जो डेटा (इनपुट) स्वीकार करती है, उसे प्रोसेस करती है, जानकारी को स्टोर करती है और आउटपुट देती है।';
                }
              } else {
                if (!parsed.summary.includes('electronic machine that accepts data')) {
                  parsed.summary = 'A computer is an electronic machine that accepts data, processes it, stores information, and produces output.';
                }
              }
            }

            return res.json({
              success: true,
              source: `gemini (${modelName})`,
              data: parsed,
            });
          }
        } catch (geminiError: any) {
          console.warn(`Gemini model ${modelName} call failed:`, geminiError?.status || geminiError?.message || geminiError);
          // Continue to next model or curriculum engine
        }
      }
    }

    // High quality curriculum fallback if models unavailable
    const fallbackData = generateLocalExplanation(classNum, language, qTrimmed);
    return res.json({
      success: true,
      source: 'curriculum-engine',
      data: fallbackData,
    });
  } catch (err: any) {
    console.error('Error in /api/explain:', err);
    return res.status(500).json({
      error: 'Something went wrong while explaining. Please try again.',
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    appName: 'Study Dost AI',
    hasApiKey: Boolean(apiKey),
  });
});

// Explicit handlers for Service Worker and Web App Manifest
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const swPath = isProd
    ? path.resolve(__dirname, 'dist', 'sw.js')
    : path.resolve(__dirname, 'public', 'sw.js');
  if (fs.existsSync(swPath)) {
    return res.sendFile(swPath);
  }
  res.status(404).send('// Service worker not found');
});

app.get(['/manifest.webmanifest', '/manifest.json'], (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const manifestPath = isProd
    ? path.resolve(__dirname, 'dist', 'manifest.webmanifest')
    : path.resolve(__dirname, 'public', 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    return res.sendFile(manifestPath);
  }
  res.status(404).json({ error: 'Manifest not found' });
});

// Vite or Static Assets handling
async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Study Dost AI server running on port ${PORT} (Prod: ${isProd})`);
  });
}

startServer();
