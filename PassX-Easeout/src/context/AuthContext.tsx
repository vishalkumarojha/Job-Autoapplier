import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { FirebaseAuthTypes } from '@react-native-firebase/auth';
import storage from '@react-native-firebase/storage';
import { auth, firestore } from '../services/firebase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AuthContextType {
  user: FirebaseAuthTypes.User | null;
  userProfile: UserProfile | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  updateProfilePhoto: (localUri: string) => Promise<void>;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  createdAt: any;
}

// ─── Context ─────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ─── Provider ────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = auth().onAuthStateChanged(async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        await fetchUserProfile(firebaseUser.uid);
      } else {
        setUserProfile(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const fetchUserProfile = async (uid: string) => {
    try {
      const unsub = firestore()
        .collection('users')
        .doc(uid)
        .onSnapshot((doc) => {
          if (doc.exists()) setUserProfile(doc.data() as UserProfile);
        });
      return unsub;
    } catch (error) {
      console.error('Error fetching user profile:', error);
    }
  };

  const login = async (email: string, password: string) => {
    await auth().signInWithEmailAndPassword(email.trim(), password);
  };

  const signup = async (email: string, password: string, displayName: string) => {
    const cred = await auth().createUserWithEmailAndPassword(email.trim(), password);
    await cred.user.updateProfile({ displayName: displayName.trim() });
    const profile: UserProfile = {
      uid: cred.user.uid,
      email: email.trim(),
      displayName: displayName.trim(),
      createdAt: firestore.FieldValue.serverTimestamp(),
    };
    await firestore().collection('users').doc(cred.user.uid).set(profile);
    setUserProfile(profile);
  };

  const logout = async () => {
    await auth().signOut();
    setUserProfile(null);
  };

  const updateProfilePhoto = async (localUri: string) => {
    if (!user) return;
    // Upload to Firebase Storage
    const ref = storage().ref(`profile_photos/${user.uid}.jpg`);
    await ref.putFile(localUri);
    const downloadURL = await ref.getDownloadURL();
    // Update Firebase Auth profile
    await user.updateProfile({ photoURL: downloadURL });
    // Update Firestore
    await firestore().collection('users').doc(user.uid).update({ photoURL: downloadURL });
    setUserProfile((prev) => prev ? { ...prev, photoURL: downloadURL } : prev);
  };

  return (
    <AuthContext.Provider value={{ user, userProfile, loading, login, signup, logout, updateProfilePhoto }}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
