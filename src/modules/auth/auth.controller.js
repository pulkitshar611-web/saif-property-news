const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const prisma = require('../../config/prisma');
const { generateTokens } = require('../../utils/token');

// Login Controller
exports.login = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password } = req.body;

        // Find user
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Tenant/Owner may have no password set until they use the invite link
        if (!user.password || user.password.trim() === '') {
            return res.status(401).json({
                message: 'No password set for this account. Please use your invite link to set a password first.'
            });
        }

        // Validate password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Generate Tokens
        const { accessToken, refreshToken } = generateTokens(user);

        // Store Refresh Token
        // First, delete old tokens for this user to keep it clean (optional, strictly one session or multiple?)
        // Let's just create a new one.
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        await prisma.refreshToken.create({
            data: {
                token: refreshToken,
                userId: user.id,
                expiresAt,
            },
        });

        res.json({
            message: 'Login successful',
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
            },
        });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// Validation Rules
exports.validateLogin = [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').exists().withMessage('Password is required'),
];

exports.getInviteDetails = async (req, res) => {
    try {
        const { token } = req.params;
        const user = await prisma.user.findUnique({
            where: { inviteToken: token }
        });

        if (!user || (user.inviteExpires && user.inviteExpires < new Date())) {
            return res.status(404).json({ message: 'Invalid or expired invite token' });
        }

        res.json({
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName
        });
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

exports.acceptInvite = async (req, res) => {
    try {
        const { token, password } = req.body;
        const user = await prisma.user.findUnique({
            where: { inviteToken: token }
        });

        if (!user || (user.inviteExpires && user.inviteExpires < new Date())) {
            return res.status(404).json({ message: 'Invalid or expired invite token' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                inviteToken: null,
                inviteExpires: null
            }
        });

        res.json({ message: 'Password set successfully. You can now login.' });
    } catch (e) {
        console.error('Accept Invite Error:', e);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getProfile = async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                phone: true,
                firstName: true,
                lastName: true,
                city: true,
                state: true,
                country: true,
                createdAt: true
            }
        });
        res.json(user);
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const { name, email, password, firstName, lastName, phone, city, state, country } = req.body;
        const userId = req.user.id;

        const updateData = {};
        if (name) updateData.name = name;
        if (firstName) updateData.firstName = firstName;
        if (lastName) updateData.lastName = lastName;
        if (city !== undefined) updateData.city = city;
        if (state !== undefined) updateData.state = state;
        if (country !== undefined) updateData.country = country;

        if (phone) {
            const digits = phone.replace(/\D/g, '');
            if (digits.length === 11 && digits.startsWith('1')) {
                updateData.phone = '+' + digits;
            } else if (digits.length === 10) {
                updateData.phone = '+1' + digits;
            } else {
                updateData.phone = phone;
            }
        }

        if (email) {
            // Check if email already taken
            const existingUser = await prisma.user.findFirst({
                where: {
                    email,
                    id: { not: userId }
                }
            });
            if (existingUser) {
                return res.status(400).json({ message: 'Email already in use' });
            }
            updateData.email = email;
        }

        if (password) {
            updateData.password = await bcrypt.hash(password, 10);
        }

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                phone: true,
                firstName: true,
                lastName: true,
                city: true,
                state: true,
                country: true
            }
        });

        res.json({
            message: 'Profile updated successfully',
            user: updatedUser
        });
    } catch (e) {
        console.error('Update Profile Error:', e);
        res.status(500).json({ message: 'Server error' });
    }
};
