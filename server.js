const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;


const MAX_CONTACTS = 370; // 👈 CHANGE THIS VALUE TO SET MAXIMUM CONTACTS


const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);


app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20
});


function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}


function validatePhoneNumber(phone) {
  return /^\d{9,12}$/.test(phone);
}


async function checkWhatsApp(phone) {
  try {
    const response = await fetch(`https://apiskeith.top/onwhatsapp?q=${phone}`);
    const data = await response.json();
    return data.result?.onWhatsApp === true;
  } catch (error) {
    console.error('WhatsApp check error:', error);
    return false;
  }
}


const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');
  
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
};


async function initializeDatabase() {
  console.log('🔄 Checking database connection...');
  
  try {
    const { error: testError } = await supabase
      .from('contacts')
      .select('id')
      .limit(1);
    
    if (testError && testError.code === '42P01') {
      console.log('⚠️ Please create the contacts table in Supabase SQL editor:');
      console.log(`
        CREATE TABLE contacts (
          id BIGSERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT NOT NULL UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } else if (testError) {
      console.log('❌ Database error:', testError.message);
    } else {
      console.log('✅ Database connected');
    }
  } catch (error) {
    console.log('⚠️ Database note:', error.message);
  }
}

// Get server config (max limit)
app.get('/api/config', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true });
    
    if (error) throw error;
    
    res.json({ 
      maxLimit: MAX_CONTACTS,
      totalContacts: count || 0,
      remaining: MAX_CONTACTS - (count || 0)
    });
  } catch (error) {
    console.error('Config error:', error);
    res.status(500).json({ error: 'Error fetching config' });
  }
});

// Public route with WhatsApp validation
app.post('/upload', uploadLimiter, async (req, res) => {
  try {
    const { name, phone } = req.body;
    
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    
    if (name.length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }
    
    const cleanPhone = formatPhoneNumber(phone);
    
    if (!validatePhoneNumber(cleanPhone)) {
      return res.status(400).json({ error: 'Invalid phone number. Must be 9-12 digits' });
    }
    
    // Check WhatsApp
    const isOnWhatsApp = await checkWhatsApp(cleanPhone);
    if (!isOnWhatsApp) {
      return res.status(400).json({ error: '❌ Number is not registered on WhatsApp' });
    }
    
    // Check total contacts
    const { count, error: countError } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      return res.status(500).json({ error: 'Database error' });
    }
    
    if (count >= MAX_CONTACTS) {
      return res.status(400).json({ error: `Maximum ${MAX_CONTACTS} contacts reached` });
    }
    
    // Insert contact
    const { data, error } = await supabase
      .from('contacts')
      .insert([{ name: name.trim(), phone: cleanPhone }])
      .select();
    
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Phone number already exists' });
      }
      console.error('Insert error:', error);
      return res.status(500).json({ error: 'Error saving contact' });
    }
    
    res.json({ success: true, message: 'Contact submitted successfully!' });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/check-contact', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    const cleanPhone = formatPhoneNumber(phone);
    
    const { data, error } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone', cleanPhone)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: 'Error checking contact' });
    }
    
    res.json({ exists: !!data });
  } catch (error) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin routes
app.get('/admin/contacts', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json(data || []);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Error fetching contacts' });
  }
});

app.post('/admin/contact', adminAuth, async (req, res) => {
  try {
    const { name, phone } = req.body;
    
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    
    const cleanPhone = formatPhoneNumber(phone);
    
    if (!validatePhoneNumber(cleanPhone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    // Check if phone exists
    const { data: existing } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone', cleanPhone)
      .single();
    
    if (existing) {
      return res.status(409).json({ error: 'Phone number already exists' });
    }
    
    // Check total contacts limit for admin add
    const { count, error: countError } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      return res.status(500).json({ error: 'Database error' });
    }
    
    if (count >= MAX_CONTACTS) {
      return res.status(400).json({ error: `Maximum ${MAX_CONTACTS} contacts reached` });
    }
    
    const { data, error } = await supabase
      .from('contacts')
      .insert([{ name: name.trim(), phone: cleanPhone }])
      .select();
    
    if (error) throw error;
    
    res.json({ success: true, message: 'Contact added successfully' });
  } catch (error) {
    console.error('Add error:', error);
    res.status(500).json({ error: 'Error adding contact' });
  }
});

app.delete('/admin/contact/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Error deleting contact' });
  }
});

app.put('/admin/contact/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone } = req.body;
    
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone required' });
    }
    
    const cleanPhone = formatPhoneNumber(phone);
    
    if (!validatePhoneNumber(cleanPhone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    // Check if phone exists for other contact
    const { data: existing } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone', cleanPhone)
      .neq('id', id)
      .single();
    
    if (existing) {
      return res.status(409).json({ error: 'Phone number already exists' });
    }
    
    const { error } = await supabase
      .from('contacts')
      .update({ name: name.trim(), phone: cleanPhone })
      .eq('id', id);
    
    if (error) throw error;
    
    res.json({ success: true });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Error updating contact' });
  }
});

app.get('/admin/download', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'No contacts found' });
    }
    
    // Generate VCF with 🫆 emoji
    const vcfData = data.map(contact => {
      const formattedName = `${contact.name} 🫆`;
      const phoneNumber = `+${contact.phone}`;
      
      return `BEGIN:VCARD
VERSION:3.0
FN:${formattedName}
N:${formattedName};;;;
TEL;TYPE=CELL:${phoneNumber}
END:VCARD`;
    }).join('\n');
    
    res.set({
      'Content-Type': 'text/vcard',
      'Content-Disposition': 'attachment; filename="Keith_VCF_Contacts.vcf"'
    });
    res.send(vcfData);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Error generating VCF' });
  }
});

app.get('/admin/stats', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true });
    
    if (error) throw error;
    
    res.json({ 
      totalContacts: count || 0, 
      maxLimit: MAX_CONTACTS,
      remaining: MAX_CONTACTS - (count || 0)
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Error fetching stats' });
  }
});

// Serve HTML files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start server
initializeDatabase();

app.listen(PORT, () => {
  console.log(`\n=================================`);
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`📱 Public upload: http://localhost:${PORT}`);
  console.log(`🔐 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`👤 Login: ${process.env.ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD}`);
  console.log(`📊 Maximum contacts: ${MAX_CONTACTS}`);
  console.log(`=================================\n`);
  
  if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'));
  }
});
